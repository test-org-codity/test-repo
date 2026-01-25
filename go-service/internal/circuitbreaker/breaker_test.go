package circuitbreaker

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

func newTestConfig() Config {
	return Config{
		FailureThreshold:     3,
		SuccessThreshold:     2,
		Timeout:              50 * time.Millisecond,
		HalfOpenMaxCalls:     2,
		SlidingWindowSize:    10,
		FailureRateThreshold: 2.0, // disable failure-rate opening for most tests
	}
}

func newTestCB(name string) *CircuitBreaker {
	cfg := newTestConfig()
	cb := New(name, cfg)
	cb.clearSlidingWindow()
	return cb
}

func resetRegistry() {
	registryMu.Lock()
	defer registryMu.Unlock()
	registry = make(map[string]*CircuitBreaker)
}

func TestRingBuffer_AddAndAverage(t *testing.T) {
	rb := NewRingBuffer(3)
	assert.Equal(t, time.Duration(0), rb.Average())

	rb.Add(100 * time.Millisecond)
	rb.Add(200 * time.Millisecond)
	assert.Equal(t, 150*time.Millisecond, rb.Average())

	rb.Add(300 * time.Millisecond)
	assert.Equal(t, 200*time.Millisecond, rb.Average())

	// Overwrite oldest (100ms) with 600ms => (600 + 200 + 300)/3 = 366ms (truncated)
	rb.Add(600 * time.Millisecond)
	assert.Equal(t, (600*time.Millisecond+200*time.Millisecond+300*time.Millisecond)/3, rb.Average())
}

func TestCircuitBreaker_Execute_SuccessAndMetrics(t *testing.T) {
	cb := newTestCB("cb-success")
	err := cb.Execute(context.Background(), func() error { return nil })
	assert.NoError(t, err)
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.TotalCalls))
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.SuccessfulCalls))
	assert.Equal(t, uint64(0), atomic.LoadUint64(&cb.metrics.FailedCalls))
	assert.Equal(t, StateClosed, cb.State())
}

func TestCircuitBreaker_Execute_FailureThresholdOpens(t *testing.T) {
	cb := newTestCB("cb-failure-threshold")
	cb.config.FailureThreshold = 3
	cb.config.FailureRateThreshold = 2.0 // ensure failure-rate does not open
	cb.clearSlidingWindow()

	opErr := errors.New("boom")
	for i := 0; i < 3; i++ {
		_ = cb.Execute(context.Background(), func() error { return opErr })
	}
	assert.Equal(t, uint64(3), atomic.LoadUint64(&cb.metrics.TotalCalls))
	assert.Equal(t, uint64(3), atomic.LoadUint64(&cb.metrics.FailedCalls))
	assert.Equal(t, StateOpen, cb.State())
}

func TestCircuitBreaker_OpenStateRejectsAndCountsRejected(t *testing.T) {
	cb := newTestCB("cb-open-reject")
	cb.config.Timeout = 500 * time.Millisecond // keep open
	cb.transitionTo(StateOpen)
	cb.openedAt.Store(time.Now())

	err := cb.Execute(context.Background(), func() error { return nil })
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "is open")
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.RejectedCalls))
}

func TestCircuitBreaker_HalfOpen_AllowsLimitedCalls_ClosesOnSuccess(t *testing.T) {
	cb := newTestCB("cb-half-open-limit")
	cb.config.HalfOpenMaxCalls = 2
	cb.config.SuccessThreshold = 2
	cb.config.Timeout = 1 * time.Millisecond
	cb.transitionTo(StateOpen)
	cb.openedAt.Store(time.Now().Add(-2 * time.Millisecond)) // ensure reset allowed

	startCh := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(4)

	results := make(chan error, 4)
	op := func() error {
		time.Sleep(10 * time.Millisecond)
		return nil
	}

	for i := 0; i < 4; i++ {
		go func() {
			defer wg.Done()
			<-startCh
			results <- cb.Execute(context.Background(), op)
		}()
	}
	close(startCh)
	wg.Wait()
	close(results)

	var ok, rejected int
	for err := range results {
		if err == nil {
			ok++
		} else {
			rejected++
		}
	}

	assert.Equal(t, 2, ok, "exactly HalfOpenMaxCalls should be allowed")
	assert.Equal(t, 2, rejected, "remaining calls should be rejected")
	assert.Equal(t, StateClosed, cb.State(), "should close after reaching success threshold")
}

func TestCircuitBreaker_HalfOpen_FailureReopens(t *testing.T) {
	cb := newTestCB("cb-half-open-failure")
	cb.config.Timeout = 1 * time.Millisecond
	cb.transitionTo(StateOpen)
	cb.openedAt.Store(time.Now().Add(-2 * time.Millisecond)) // allow reset

	// First call enters half-open and fails -> should reopen
	err := cb.Execute(context.Background(), func() error { return errors.New("fail") })
	assert.Error(t, err)
	assert.Equal(t, StateOpen, cb.State())
}

func TestCircuitBreaker_FailureRateThreshold_Opens(t *testing.T) {
	cb := New("cb-rate", Config{
		FailureThreshold:     10, // disable threshold opening
		SuccessThreshold:     2,
		Timeout:              50 * time.Millisecond,
		HalfOpenMaxCalls:     2,
		SlidingWindowSize:    4,
		FailureRateThreshold: 0.5,
	})
	cb.clearSlidingWindow()

	// Two failures among window size 4 should reach 0.5 and open
	_ = cb.Execute(context.Background(), func() error { return errors.New("x") }) // 1/4
	assert.Equal(t, StateClosed, cb.State())

	_ = cb.Execute(context.Background(), func() error { return errors.New("x") }) // 2/4 -> >= 0.5
	assert.Equal(t, StateOpen, cb.State())
}

func TestCircuitBreaker_ExecuteWithFallback(t *testing.T) {
	cb := newTestCB("cb-fallback")
	cb.clearSlidingWindow()

	// Operation fails, fallback succeeds (returns nil)
	err := cb.ExecuteWithFallback(context.Background(),
		func() error { return errors.New("op fail") },
		func() error { return nil },
	)
	assert.NoError(t, err)
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.FailedCalls))

	// Operation fails, fallback fails
	err2 := cb.ExecuteWithFallback(context.Background(),
		func() error { return errors.New("op fail") },
		func() error { return errors.New("fallback fail") },
	)
	assert.Error(t, err2)
	assert.Contains(t, err2.Error(), "fallback fail")
}

func TestCircuitBreaker_GetHealthInfo_PopulatesMetrics(t *testing.T) {
	cb := newTestCB("cb-health")
	cb.clearSlidingWindow()
	cb.config.FailureRateThreshold = 2.0 // avoid opening due to rate

	// Simulate outcomes with durations without using Execute to control times
	cb.recordSuccess(100 * time.Millisecond)
	cb.recordFailure(200 * time.Millisecond)
	cb.recordSuccess(300 * time.Millisecond)

	hi := cb.GetHealthInfo()
	assert.Equal(t, "cb-health", hi.Name)
	assert.Equal(t, "CLOSED", hi.State)
	assert.Equal(t, 0, hi.FailureCount) // one failure then success decrements
	assert.Equal(t, 0, hi.SuccessCount) // successCount used for half-open; in closed it resets
	assert.InDelta(t, 200, hi.Metrics["avg_response_time_ms"], 1.0)
	assert.Equal(t, uint64(2), hi.Metrics["successful_calls"].(uint64))
	assert.Equal(t, uint64(1), hi.Metrics["failed_calls"].(uint64))
}

func TestCircuitBreaker_NameAndState(t *testing.T) {
	cb := newTestCB("cb-name")
	assert.Equal(t, "cb-name", cb.Name())
	assert.Equal(t, StateClosed, cb.State())
	assert.Equal(t, "CLOSED", cb.State().String())

	cb.transitionTo(StateOpen)
	assert.Equal(t, "OPEN", cb.State().String())

	cb.transitionTo(StateHalfOpen)
	assert.Equal(t, "HALF_OPEN", cb.State().String())
}

func TestDefaultConfig(t *testing.T) {
	cfg := DefaultConfig()
	assert.True(t, cfg.FailureThreshold > 0)
	assert.True(t, cfg.SuccessThreshold > 0)
	assert.True(t, cfg.Timeout > 0)
	assert.True(t, cfg.HalfOpenMaxCalls > 0)
	assert.True(t, cfg.SlidingWindowSize > 0)
	assert.True(t, cfg.FailureRateThreshold > 0)
}

func TestGetOrCreate_ReturnsSingletonPerName(t *testing.T) {
	resetRegistry()
	cfg1 := newTestConfig()
	cfg2 := Config{
		FailureThreshold:     10,
		SuccessThreshold:     1,
		Timeout:              5 * time.Second,
		HalfOpenMaxCalls:     1,
		SlidingWindowSize:    5,
		FailureRateThreshold: 0.9,
	}

	cb1 := GetOrCreate("svc", cfg1)
	cb2 := GetOrCreate("svc", cfg2)

	assert.Same(t, cb1, cb2)
	assert.Equal(t, cfg1.FailureThreshold, cb2.config.FailureThreshold)
}

func TestDistributedCoordinator_RegisterAndSync(t *testing.T) {
	var mu sync.Mutex
	var calls int
	var lastPath string

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		calls++
		lastPath = r.URL.Path
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	dc := NewDistributedCoordinator(server.URL)
	dc.client = server.Client() // use test server client

	cb := newTestCB("svc-a")
	dc.Register(cb)

	dc.syncStates()

	// Allow some time for network roundtrip
	time.Sleep(10 * time.Millisecond)

	mu.Lock()
	defer mu.Unlock()
	assert.GreaterOrEqual(t, calls, 1)
	assert.Equal(t, "/circuit-breakers/state", lastPath)
}

func TestDistributedCoordinator_StartSyncAndStop(t *testing.T) {
	var mu sync.Mutex
	var calls int

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		calls++
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	dc := NewDistributedCoordinator(server.URL)
	dc.client = server.Client()
	dc.syncInterval = 10 * time.Millisecond

	cb := newTestCB("svc-b")
	dc.Register(cb)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go dc.StartSync(ctx)

	time.Sleep(35 * time.Millisecond)
	dc.Stop()
	time.Sleep(15 * time.Millisecond)

	mu.Lock()
	c := calls
	mu.Unlock()

	assert.GreaterOrEqual(t, c, 2)
}

func TestCalculateFailureRate(t *testing.T) {
	cb := New("cb-rate-calc", Config{
		FailureThreshold:     10,
		SuccessThreshold:     1,
		Timeout:              100 * time.Millisecond,
		HalfOpenMaxCalls:     2,
		SlidingWindowSize:    4,
		FailureRateThreshold: 1.0,
	})
	cb.clearSlidingWindow() // start with all successes

	// Set two failures and two successes
	cb.addToSlidingWindow(false)
	cb.addToSlidingWindow(false)
	cb.addToSlidingWindow(true)
	cb.addToSlidingWindow(true)

	assert.InDelta(t, 0.5, cb.calculateFailureRate(), 0.0001)
}
