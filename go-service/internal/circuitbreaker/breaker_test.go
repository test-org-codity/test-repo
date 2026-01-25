package circuitbreaker

import (
	"context"
	"net/http"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

func TestState_String(t *testing.T) {
	tests := []struct {
		name string
		s    State
		want string
	}{
		{"closed", StateClosed, "CLOSED"},
		{"open", StateOpen, "OPEN"},
		{"half_open", StateHalfOpen, "HALF_OPEN"},
		{"unknown", State(99), "UNKNOWN"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.want, tt.s.String())
		})
	}
}

func TestDefaultConfig(t *testing.T) {
	cfg := DefaultConfig()
	assert.Equal(t, 5, cfg.FailureThreshold)
	assert.Equal(t, 3, cfg.SuccessThreshold)
	assert.Equal(t, 30*time.Second, cfg.Timeout)
	assert.Equal(t, 3, cfg.HalfOpenMaxCalls)
	assert.Equal(t, 10, cfg.SlidingWindowSize)
	assert.Equal(t, 0.5, cfg.FailureRateThreshold)
}

func TestNewRingBuffer_AddAndAverage(t *testing.T) {
	rb := NewRingBuffer(3)
	assert.Equal(t, time.Duration(0), rb.Average())

	rb.Add(10 * time.Millisecond)
	assert.Equal(t, 10*time.Millisecond, rb.Average())

	rb.Add(20 * time.Millisecond)
	assert.Equal(t, 15*time.Millisecond, rb.Average())

	rb.Add(30 * time.Millisecond)
	assert.Equal(t, 20*time.Millisecond, rb.Average())

	// Overwrite oldest
	rb.Add(40 * time.Millisecond)
	// Now buffer has 40,20,30 (order in data slice not important, but average is)
	assert.Equal(t, (40+20+30)/3*time.Millisecond/1, rb.Average())
}

func TestNewCircuitBreaker_InitialState(t *testing.T) {
	cfg := DefaultConfig()
	cb := New("test", cfg)

	assert.Equal(t, "test", cb.Name())
	assert.Equal(t, StateClosed, cb.State())
	assert.NotNil(t, cb.metrics)
	assert.NotNil(t, cb.metrics.responseTimes)
	assert.Len(t, cb.slidingWindow, cfg.SlidingWindowSize)
}

func TestGetOrCreate_ReturnsSameInstance(t *testing.T) {
	cfg := DefaultConfig()
	name := "shared"

	cb1 := GetOrCreate(name, cfg)
	cb2 := GetOrCreate(name, cfg)

	assert.Same(t, cb1, cb2)
}

func TestCircuitBreaker_Execute_SuccessKeepsClosed(t *testing.T) {
	cfg := DefaultConfig()
	cb := New("exec-success", cfg)

	ctx := context.Background()
	err := cb.Execute(ctx, func() error {
		return nil
	})

	assert.NoError(t, err)
	assert.Equal(t, StateClosed, cb.State())
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.TotalCalls))
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.SuccessfulCalls))
	assert.Equal(t, uint64(0), atomic.LoadUint64(&cb.metrics.FailedCalls))
}

func TestCircuitBreaker_Execute_FailureIncrementsAndOpens(t *testing.T) {
	cfg := DefaultConfig()
	cfg.FailureThreshold = 2
	cfg.SlidingWindowSize = 2
	cfg.FailureRateThreshold = 1.0
	cb := New("exec-fail", cfg)

	ctx := context.Background()
	opErr := assert.AnError

	// first failure - still closed
	err := cb.Execute(ctx, func() error {
		return opErr
	})
	assert.Equal(t, opErr, err)
	assert.Equal(t, StateClosed, cb.State())

	// second failure - should open
	err = cb.Execute(ctx, func() error {
		return opErr
	})
	assert.Equal(t, opErr, err)
	assert.Equal(t, StateOpen, cb.State())
	assert.Equal(t, uint64(2), atomic.LoadUint64(&cb.metrics.FailedCalls))
}

func TestCircuitBreaker_Execute_OpenRejects(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Timeout = time.Hour
	cb := New("exec-open", cfg)

	// force open
	cb.transitionTo(StateOpen)

	ctx := context.Background()
	err := cb.Execute(ctx, func() error {
		return nil
	})

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "circuit breaker 'exec-open' is open")
	assert.Equal(t, uint64(0), atomic.LoadUint64(&cb.metrics.SuccessfulCalls))
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.RejectedCalls))
}

func TestCircuitBreaker_ExecuteWithFallback_UsesFallbackOnError(t *testing.T) {
	cfg := DefaultConfig()
	cb := New("exec-fallback", cfg)

	ctx := context.Background()
	opErr := assert.AnError
	fallbackCalled := false

	err := cb.ExecuteWithFallback(ctx,
		func() error {
			return opErr
		},
		func() error {
			fallbackCalled = true
			return nil
		},
	)

	assert.NoError(t, err)
	assert.True(t, fallbackCalled)
}

func TestCircuitBreaker_ExecuteWithFallback_NoFallbackPropagatesError(t *testing.T) {
	cfg := DefaultConfig()
	cb := New("exec-fallback-nil", cfg)

	ctx := context.Background()
	opErr := assert.AnError

	err := cb.ExecuteWithFallback(ctx,
		func() error {
			return opErr
		},
		nil,
	)

	assert.Equal(t, opErr, err)
}

func TestCircuitBreaker_allowRequest_ClosedAlwaysAllows(t *testing.T) {
	cfg := DefaultConfig()
	cb := New("allow-closed", cfg)

	cb.transitionTo(StateClosed)
	assert.True(t, cb.allowRequest())
}

func TestCircuitBreaker_allowRequest_OpenRespectsTimeoutAndHalfOpenLimit(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Timeout = 10 * time.Millisecond
	cfg.HalfOpenMaxCalls = 2
	cb := New("allow-open", cfg)

	// open and set openedAt in the past
	cb.transitionTo(StateOpen)
	cb.openedAt.Store(time.Now().Add(-20 * time.Millisecond))

	// first allowRequest should move to half-open and allow
	assert.True(t, cb.allowRequest())
	assert.Equal(t, StateHalfOpen, cb.State())

	// in half-open, only HalfOpenMaxCalls allowed
	assert.True(t, cb.allowRequest())
	assert.False(t, cb.allowRequest())
}

func TestCircuitBreaker_shouldAttemptReset(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Timeout = 5 * time.Millisecond
	cb := New("reset", cfg)

	// no openedAt set
	assert.False(t, cb.shouldAttemptReset())

	// set openedAt to now - timeout not reached
	cb.openedAt.Store(time.Now())
	assert.False(t, cb.shouldAttemptReset())

	// set openedAt in the past beyond timeout
	cb.openedAt.Store(time.Now().Add(-10 * time.Millisecond))
	assert.True(t, cb.shouldAttemptReset())
}

func TestCircuitBreaker_transitionTo_UpdatesStateAndMetrics(t *testing.T) {
	cfg := DefaultConfig()
	cb := New("transition", cfg)

	var fromCaptured, toCaptured State
	var nameCaptured string
	cb.onStateChange = func(name string, from, to State) {
		nameCaptured = name
		fromCaptured = from
		toCaptured = to
	}

	cb.transitionTo(StateOpen)
	assert.Equal(t, StateOpen, cb.State())
	assert.NotNil(t, cb.openedAt.Load())
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.StateChanges))

	cb.transitionTo(StateHalfOpen)
	assert.Equal(t, StateHalfOpen, cb.State())
	assert.Equal(t, int32(0), atomic.LoadInt32(&cb.halfOpenCalls))
	assert.Equal(t, int32(0), atomic.LoadInt32(&cb.successCount))

	cb.transitionTo(StateClosed)
	assert.Equal(t, StateClosed, cb.State())
	assert.Equal(t, int32(0), atomic.LoadInt32(&cb.failureCount))
	assert.Equal(t, int32(0), atomic.LoadInt32(&cb.successCount))

	assert.Equal(t, "transition", nameCaptured)
	assert.Equal(t, StateOpen, fromCaptured)
	assert.Equal(t, StateHalfOpen, toCaptured)
}

func TestCircuitBreaker_recordSuccess_InHalfOpenClosesAfterThreshold(t *testing.T) {
	cfg := DefaultConfig()
	cfg.SuccessThreshold = 2
	cb := New("success-half-open", cfg)

	cb.transitionTo(StateHalfOpen)

	cb.recordSuccess(5 * time.Millisecond)
	assert.Equal(t, StateHalfOpen, cb.State())

	cb.recordSuccess(5 * time.Millisecond)
	assert.Equal(t, StateClosed, cb.State())
}

func TestCircuitBreaker_recordSuccess_InClosedDecrementsFailureCount(t *testing.T) {
	cfg := DefaultConfig()
	cb := New("success-closed", cfg)

	cb.transitionTo(StateClosed)
	atomic.StoreInt32(&cb.failureCount, 2)

	cb.recordSuccess(5 * time.Millisecond)
	assert.Equal(t, int32(1), atomic.LoadInt32(&cb.failureCount))

	cb.recordSuccess(5 * time.Millisecond)
	assert.Equal(t, int32(0), atomic.LoadInt32(&cb.failureCount))

	// should not go negative
	cb.recordSuccess(5 * time.Millisecond)
	assert.Equal(t, int32(0), atomic.LoadInt32(&cb.failureCount))
}

func TestCircuitBreaker_recordFailure_InHalfOpenOpensImmediately(t *testing.T) {
	cfg := DefaultConfig()
	cb := New("failure-half-open", cfg)

	cb.transitionTo(StateHalfOpen)
	cb.recordFailure(5 * time.Millisecond)

	assert.Equal(t, StateOpen, cb.State())
}

func TestCircuitBreaker_recordFailure_InClosedUsesThresholdAndRate(t *testing.T) {
	cfg := DefaultConfig()
	cfg.FailureThreshold = 3
	cfg.SlidingWindowSize = 4
	cfg.FailureRateThreshold = 0.5
	cb := New("failure-closed", cfg)

	cb.transitionTo(StateClosed)

	// first failure - below threshold and rate
	cb.recordFailure(5 * time.Millisecond)
	assert.Equal(t, StateClosed, cb.State())

	// second failure - threshold not reached, but rate 2/4=0.5 => open
	cb.recordFailure(5 * time.Millisecond)
	assert.Equal(t, StateOpen, cb.State())
}

func TestCircuitBreaker_addToSlidingWindowAndCalculateFailureRate(t *testing.T) {
	cfg := DefaultConfig()
	cfg.SlidingWindowSize = 4
	cb := New("window", cfg)

	cb.addToSlidingWindow(true)
	cb.addToSlidingWindow(false)
	cb.addToSlidingWindow(false)
	cb.addToSlidingWindow(true)

	rate := cb.calculateFailureRate()
	assert.InDelta(t, 0.5, rate, 0.0001)
}

func TestCircuitBreaker_clearSlidingWindow(t *testing.T) {
	cfg := DefaultConfig()
	cfg.SlidingWindowSize = 3
	cb := New("clear-window", cfg)

	cb.addToSlidingWindow(false)
	cb.addToSlidingWindow(false)
	cb.addToSlidingWindow(false)

	cb.clearSlidingWindow()
	rate := cb.calculateFailureRate()
	assert.InDelta(t, 0.0, rate, 0.0001)
}

func TestCircuitBreaker_GetHealthInfo(t *testing.T) {
	cfg := DefaultConfig()
	cfg.SlidingWindowSize = 2
	cb := New("health", cfg)

	// simulate one success and one failure
	cb.recordSuccess(10 * time.Millisecond)
	cb.recordFailure(20 * time.Millisecond)

	hi := cb.GetHealthInfo()
	assert.Equal(t, "health", hi.Name)
	assert.Equal(t, cb.State().String(), hi.State)
	assert.Equal(t, int(atomic.LoadInt32(&cb.failureCount)), hi.FailureCount)
	assert.Equal(t, int(atomic.LoadInt32(&cb.successCount)), hi.SuccessCount)
	assert.InDelta(t, cb.calculateFailureRate(), hi.FailureRate, 0.0001)

	assert.Equal(t, atomic.LoadUint64(&cb.metrics.TotalCalls), hi.Metrics["total_calls"])
	assert.Equal(t, atomic.LoadUint64(&cb.metrics.SuccessfulCalls), hi.Metrics["successful_calls"])
	assert.Equal(t, atomic.LoadUint64(&cb.metrics.FailedCalls), hi.Metrics["failed_calls"])
	assert.Equal(t, atomic.LoadUint64(&cb.metrics.RejectedCalls), hi.Metrics["rejected_calls"])
	assert.Equal(t, atomic.LoadUint64(&cb.metrics.StateChanges), hi.Metrics["state_changes"])
	// avg_response_time_ms is an int64 from Milliseconds()
	_, ok := hi.Metrics["avg_response_time_ms"].(int64)
	assert.True(t, ok)
}

func TestNewDistributedCoordinator_Defaults(t *testing.T) {
	// ensure NODE_ID not set for this test
	_ = os.Unsetenv("NODE_ID")

	dc := NewDistributedCoordinator("http://coordinator")

	assert.Equal(t, "http://coordinator", dc.coordinatorURL)
	assert.NotEmpty(t, dc.nodeID)
	assert.Contains(t, dc.nodeID, "go-")
	assert.NotNil(t, dc.breakers)
	assert.NotNil(t, dc.client)
	assert.Equal(t, 5*time.Second, dc.syncInterval)
	assert.NotNil(t, dc.stopChan)
}

func TestNewDistributedCoordinator_UsesEnvNodeID(t *testing.T) {
	_ = os.Setenv("NODE_ID", "node-123")
	defer os.Unsetenv("NODE_ID")

	dc := NewDistributedCoordinator("http://coordinator")
	assert.Equal(t, "node-123", dc.nodeID)
}

func TestDistributedCoordinator_Register(t *testing.T) {
	dc := NewDistributedCoordinator("http://coordinator")
	cb := New("service-a", DefaultConfig())

	dc.Register(cb)

	dc.mu.RLock()
	defer dc.mu.RUnlock()
	assert.Equal(t, cb, dc.breakers["service-a"])
}

type roundTripperFunc func(*http.Request) (*http.Response, error)

func (f roundTripperFunc) RoundTrip(r *http.Request) (*http.Response, error) {
	return f(r)
}

func TestDistributedCoordinator_syncStates_CallsReportState(t *testing.T) {
	dc := NewDistributedCoordinator("http://coordinator")
	cb1 := New("svc1", DefaultConfig())
	cb2 := New("svc2", DefaultConfig())

	dc.Register(cb1)
	dc.Register(cb2)

	var called int32
	dc.client = &http.Client{
		Transport: roundTripperFunc(func(req *http.Request) (*http.Response, error) {
			atomic.AddInt32(&called, 1)
			assert.Equal(t, "application/json", req.Header.Get("Content-Type"))
			assert.Equal(t, "http://coordinator/circuit-breakers/state", req.URL.String())
			return &http.Response{
				StatusCode: 200,
				Body:       http.NoBody,
			}, nil
		}),
		Timeout: 5 * time.Second,
	}

	dc.syncStates()
	assert.Equal(t, int32(2), atomic.LoadInt32(&called))
}

func TestDistributedCoordinator_StartSyncAndStop(t *testing.T) {
	dc := NewDistributedCoordinator("http://coordinator")
	cb := New("svc", DefaultConfig())
	dc.Register(cb)

	var called int32
	dc.client = &http.Client{
		Transport: roundTripperFunc(func(req *http.Request) (*http.Response, error) {
			atomic.AddInt32(&called, 1)
			return &http.Response{
				StatusCode: 200,
				Body:       http.NoBody,
			}, nil
		}),
		Timeout: 5 * time.Second,
	}

	// speed up sync for test
	dc.syncInterval = 10 * time.Millisecond

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go dc.StartSync(ctx)

	// let it run a bit
	time.Sleep(35 * time.Millisecond)
	dc.Stop()

	// wait a bit to ensure goroutine exits
	time.Sleep(20 * time.Millisecond)

	assert.GreaterOrEqual(t, atomic.LoadInt32(&called), int32(1))
}
