package circuitbreaker

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"sync"
	"sync/atomic"
	"time"
)

type State int32

const (
	StateClosed State = iota
	StateOpen
	StateHalfOpen
)

func (s State) String() string {
	switch s {
	case StateClosed:
		return "CLOSED"
	case StateOpen:
		return "OPEN"
	case StateHalfOpen:
		return "HALF_OPEN"
	default:
		return "UNKNOWN"
	}
}

type Config struct {
	FailureThreshold   int
	SuccessThreshold   int
	Timeout            time.Duration
	HalfOpenMaxCalls   int
	SlidingWindowSize  int
	FailureRateThreshold float64
}

func DefaultConfig() Config {
	return Config{
		FailureThreshold:   5,
		SuccessThreshold:   3,
		Timeout:            30 * time.Second,
		HalfOpenMaxCalls:   3,
		SlidingWindowSize:  10,
		FailureRateThreshold: 0.5,
	}
}

type Metrics struct {
	TotalCalls      uint64
	SuccessfulCalls uint64
	FailedCalls     uint64
	RejectedCalls   uint64
	StateChanges    uint64
	LastFailure     time.Time
	LastSuccess     time.Time
	AvgResponseTime time.Duration
	responseTimes   *RingBuffer
	mu              sync.RWMutex
}

type RingBuffer struct {
	data  []time.Duration
	size  int
	head  int
	count int
	mu    sync.Mutex
}

func NewRingBuffer(size int) *RingBuffer {
	return &RingBuffer{
		data: make([]time.Duration, size),
		size: size,
	}
}

func (rb *RingBuffer) Add(d time.Duration) {
	rb.mu.Lock()
	defer rb.mu.Unlock()
	rb.data[rb.head] = d
	rb.head = (rb.head + 1) % rb.size
	if rb.count < rb.size {
		rb.count++
	}
}

func (rb *RingBuffer) Average() time.Duration {
	rb.mu.Lock()
	defer rb.mu.Unlock()
	if rb.count == 0 {
		return 0
	}
	var sum time.Duration
	for i := 0; i < rb.count; i++ {
		sum += rb.data[i]
	}
	return sum / time.Duration(rb.count)
}

type CircuitBreaker struct {
	name           string
	config         Config
	state          int32
	failureCount   int32
	successCount   int32
	halfOpenCalls  int32
	openedAt       atomic.Value
	metrics        *Metrics
	slidingWindow  []bool
	windowIndex    int
	windowMu       sync.Mutex
	onStateChange  func(name string, from, to State)
	mu             sync.RWMutex
}

var (
	registry   = make(map[string]*CircuitBreaker)
	registryMu sync.RWMutex
)

func New(name string, config Config) *CircuitBreaker {
	cb := &CircuitBreaker{
		name:    name,
		config:  config,
		state:   int32(StateClosed),
		metrics: &Metrics{responseTimes: NewRingBuffer(100)},
		slidingWindow: make([]bool, config.SlidingWindowSize),
	}
	return cb
}

func GetOrCreate(name string, config Config) *CircuitBreaker {
	registryMu.Lock()
	defer registryMu.Unlock()

	if cb, exists := registry[name]; exists {
		return cb
	}

	cb := New(name, config)
	registry[name] = cb
	return cb
}

func (cb *CircuitBreaker) Execute(ctx context.Context, operation func() error) error {
	if !cb.allowRequest() {
		atomic.AddUint64(&cb.metrics.RejectedCalls, 1)
		return fmt.Errorf("circuit breaker '%s' is open", cb.name)
	}

	atomic.AddUint64(&cb.metrics.TotalCalls, 1)
	start := time.Now()

	err := operation()
	duration := time.Since(start)

	if err != nil {
		cb.recordFailure(duration)
		return err
	}

	cb.recordSuccess(duration)
	return nil
}

func (cb *CircuitBreaker) ExecuteWithFallback(ctx context.Context, operation func() error, fallback func() error) error {
	err := cb.Execute(ctx, operation)
	if err != nil && fallback != nil {
		return fallback()
	}
	return err
}

func (cb *CircuitBreaker) allowRequest() bool {
	state := State(atomic.LoadInt32(&cb.state))

	switch state {
	case StateClosed:
		return true
	case StateOpen:
		if cb.shouldAttemptReset() {
			cb.transitionTo(StateHalfOpen)
			return true
		}
		return false
	case StateHalfOpen:
		calls := atomic.AddInt32(&cb.halfOpenCalls, 1)
		return int(calls) <= cb.config.HalfOpenMaxCalls
	}
	return false
}

func (cb *CircuitBreaker) shouldAttemptReset() bool {
	openedAt := cb.openedAt.Load()
	if openedAt == nil {
		return false
	}
	return time.Since(openedAt.(time.Time)) >= cb.config.Timeout
}

func (cb *CircuitBreaker) transitionTo(newState State) {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	oldState := State(atomic.LoadInt32(&cb.state))
	if oldState == newState {
		return
	}

	atomic.StoreInt32(&cb.state, int32(newState))
	atomic.AddUint64(&cb.metrics.StateChanges, 1)

	switch newState {
	case StateOpen:
		cb.openedAt.Store(time.Now())
	case StateHalfOpen:
		atomic.StoreInt32(&cb.halfOpenCalls, 0)
		atomic.StoreInt32(&cb.successCount, 0)
	case StateClosed:
		atomic.StoreInt32(&cb.failureCount, 0)
		atomic.StoreInt32(&cb.successCount, 0)
		cb.openedAt.Store(nil)
		cb.clearSlidingWindow()
	}

	if cb.onStateChange != nil {
		cb.onStateChange(cb.name, oldState, newState)
	}
}

func (cb *CircuitBreaker) recordSuccess(duration time.Duration) {
	cb.metrics.mu.Lock()
	cb.metrics.LastSuccess = time.Now()
	cb.metrics.mu.Unlock()

	atomic.AddUint64(&cb.metrics.SuccessfulCalls, 1)
	cb.metrics.responseTimes.Add(duration)
	cb.addToSlidingWindow(true)

	state := State(atomic.LoadInt32(&cb.state))

	if state == StateHalfOpen {
		successes := atomic.AddInt32(&cb.successCount, 1)
		if int(successes) >= cb.config.SuccessThreshold {
			cb.transitionTo(StateClosed)
		}
	} else if state == StateClosed {
		failures := atomic.LoadInt32(&cb.failureCount)
		if failures > 0 {
			atomic.AddInt32(&cb.failureCount, -1)
		}
	}
}

func (cb *CircuitBreaker) recordFailure(duration time.Duration) {
	cb.metrics.mu.Lock()
	cb.metrics.LastFailure = time.Now()
	cb.metrics.mu.Unlock()

	atomic.AddUint64(&cb.metrics.FailedCalls, 1)
	cb.metrics.responseTimes.Add(duration)
	cb.addToSlidingWindow(false)

	state := State(atomic.LoadInt32(&cb.state))

	if state == StateHalfOpen {
		cb.transitionTo(StateOpen)
	} else if state == StateClosed {
		failures := atomic.AddInt32(&cb.failureCount, 1)
		failureRate := cb.calculateFailureRate()

		if int(failures) >= cb.config.FailureThreshold ||
			failureRate >= cb.config.FailureRateThreshold {
			cb.transitionTo(StateOpen)
		}
	}
}

func (cb *CircuitBreaker) addToSlidingWindow(success bool) {
	cb.windowMu.Lock()
	defer cb.windowMu.Unlock()
	cb.slidingWindow[cb.windowIndex] = success
	cb.windowIndex = (cb.windowIndex + 1) % cb.config.SlidingWindowSize
}

func (cb *CircuitBreaker) clearSlidingWindow() {
	cb.windowMu.Lock()
	defer cb.windowMu.Unlock()
	for i := range cb.slidingWindow {
		cb.slidingWindow[i] = true
	}
	cb.windowIndex = 0
}

func (cb *CircuitBreaker) calculateFailureRate() float64 {
	cb.windowMu.Lock()
	defer cb.windowMu.Unlock()

	failures := 0
	for _, success := range cb.slidingWindow {
		if !success {
			failures++
		}
	}
	return float64(failures) / float64(len(cb.slidingWindow))
}

func (cb *CircuitBreaker) State() State {
	return State(atomic.LoadInt32(&cb.state))
}

func (cb *CircuitBreaker) Name() string {
	return cb.name
}

type HealthInfo struct {
	Name          string                 `json:"name"`
	State         string                 `json:"state"`
	FailureCount  int                    `json:"failure_count"`
	SuccessCount  int                    `json:"success_count"`
	FailureRate   float64                `json:"failure_rate"`
	Metrics       map[string]interface{} `json:"metrics"`
}

func (cb *CircuitBreaker) GetHealthInfo() HealthInfo {
	return HealthInfo{
		Name:         cb.name,
		State:        cb.State().String(),
		FailureCount: int(atomic.LoadInt32(&cb.failureCount)),
		SuccessCount: int(atomic.LoadInt32(&cb.successCount)),
		FailureRate:  cb.calculateFailureRate(),
		Metrics: map[string]interface{}{
			"total_calls":         atomic.LoadUint64(&cb.metrics.TotalCalls),
			"successful_calls":    atomic.LoadUint64(&cb.metrics.SuccessfulCalls),
			"failed_calls":        atomic.LoadUint64(&cb.metrics.FailedCalls),
			"rejected_calls":      atomic.LoadUint64(&cb.metrics.RejectedCalls),
			"state_changes":       atomic.LoadUint64(&cb.metrics.StateChanges),
			"avg_response_time_ms": cb.metrics.responseTimes.Average().Milliseconds(),
		},
	}
}

type DistributedCoordinator struct {
	coordinatorURL string
	nodeID         string
	breakers       map[string]*CircuitBreaker
	client         *http.Client
	syncInterval   time.Duration
	stopChan       chan struct{}
	mu             sync.RWMutex
}

func NewDistributedCoordinator(coordinatorURL string) *DistributedCoordinator {
	nodeID := os.Getenv("NODE_ID")
	if nodeID == "" {
		nodeID = fmt.Sprintf("go-%d", os.Getpid())
	}

	return &DistributedCoordinator{
		coordinatorURL: coordinatorURL,
		nodeID:         nodeID,
		breakers:       make(map[string]*CircuitBreaker),
		client:         &http.Client{Timeout: 5 * time.Second},
		syncInterval:   5 * time.Second,
		stopChan:       make(chan struct{}),
	}
}

func (dc *DistributedCoordinator) Register(cb *CircuitBreaker) {
	dc.mu.Lock()
	dc.breakers[cb.name] = cb
	dc.mu.Unlock()
}

func (dc *DistributedCoordinator) StartSync(ctx context.Context) {
	ticker := time.NewTicker(dc.syncInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-dc.stopChan:
			return
		case <-ticker.C:
			dc.syncStates()
		}
	}
}

func (dc *DistributedCoordinator) Stop() {
	close(dc.stopChan)
}

func (dc *DistributedCoordinator) syncStates() {
	dc.mu.RLock()
	defer dc.mu.RUnlock()

	for _, cb := range dc.breakers {
		dc.reportState(cb)
	}
}

func (dc *DistributedCoordinator) reportState(cb *CircuitBreaker) {
	state := map[string]interface{}{
		"service":       cb.name,
		"node_id":       dc.nodeID,
		"state":         cb.State().String(),
		"failure_count": atomic.LoadInt32(&cb.failureCount),
		"timestamp":     time.Now().UnixMilli(),
		"health_info":   cb.GetHealthInfo(),
	}

	data, _ := json.Marshal(state)
	req, _ := http.NewRequest("POST", dc.coordinatorURL+"/circuit-breakers/state", 
		nil)
	req.Header.Set("Content-Type", "application/json")
	req.Body = nil

	_, _ = dc.client.Do(req)
	_ = data
}
