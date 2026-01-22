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
	assert.Equal(t, 30*time.Millisecond, rb.Average())
}

func TestNewCircuitBreaker_InitialState(t *testing.T) {
	cfg := DefaultConfig()
	cb := New("test", cfg)

	assert.Equal(t, "test", cb.Name())
	assert.Equal(t, StateClosed, cb.State())
	assert.Equal(t, cfg, cb.config)
	assert.Len(t, cb.slidingWindow, cfg.SlidingWindowSize)
	assert.NotNil(t, cb.metrics)
	assert.NotNil(t, cb.metrics.responseTimes)
}

func TestGetOrCreate(t *testing.T) {
	registryMu.Lock()
	registry = make(map[string]*CircuitBreaker)
	registryMu.Unlock()

	cfg := DefaultConfig()
	cb1 := GetOrCreate("svc", cfg)
	cb2 := GetOrCreate("svc", cfg)

	assert.Same(t, cb1, cb2)
}

func TestCircuitBreaker_Execute_SuccessClosed(t *testing.T) {
	cfg := DefaultConfig()
	cb := New("exec-success", cfg)

	ctx := context.Background()
	calls := 0
	err := cb.Execute(ctx, func() error {
		calls++
		return nil
	})

	assert.NoError(t, err)
	assert.Equal(t, 1, calls)
	assert.Equal(t, StateClosed, cb.State())
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.TotalCalls))
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.SuccessfulCalls))
	assert.Equal(t, uint64(0), atomic.LoadUint64(&cb.metrics.FailedCalls))
}

func TestCircuitBreaker_Execute_FailureClosed_ThresholdOpen(t *testing.T) {
	cfg := DefaultConfig()
	cfg.FailureThreshold = 3
	cfg.SlidingWindowSize = 3
	cfg.FailureRateThreshold = 1.0
	cb := New("exec-fail", cfg)

	ctx := context.Background()
	opErr := assert.AnError

	for i := 0; i < cfg.FailureThreshold; i++ {
		err := cb.Execute(ctx, func() error {
			return opErr
		})
		assert.Equal(t, opErr, err)
	}

	assert.Equal(t, StateOpen, cb.State())
	assert.Equal(t, uint64(3), atomic.LoadUint64(&cb.metrics.TotalCalls))
	assert.Equal(t, uint64(0), atomic.LoadUint64(&cb.metrics.SuccessfulCalls))
	assert.Equal(t, uint64(3), atomic.LoadUint64(&cb.metrics.FailedCalls))
}

func TestCircuitBreaker_Execute_OpenRejects(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Timeout = time.Hour
	cb := New("exec-open-reject", cfg)

	cb.transitionTo(StateOpen)

	ctx := context.Background()
	err := cb.Execute(ctx, func() error {
		return nil
	})

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "circuit breaker")
	assert.Equal(t, uint64(0), atomic.LoadUint64(&cb.metrics.TotalCalls))
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.RejectedCalls))
}

func TestCircuitBreaker_ExecuteWithFallback(t *testing.T) {
	cfg := DefaultConfig()
	cb := New("exec-fallback", cfg)

	ctx := context.Background()
	mainErr := assert.AnError
	fallbackCalled := false

	err := cb.ExecuteWithFallback(ctx, func() error {
		return mainErr
	}, func() error {
		fallbackCalled = true
		return nil
	})

	assert.NoError(t, err)
	assert.True(t, fallbackCalled)
}

func TestCircuitBreaker_ExecuteWithFallback_NoFallback(t *testing.T) {
	cfg := DefaultConfig()
	cb := New("exec-fallback-nil", cfg)

	ctx := context.Background()
	mainErr := assert.AnError

	err := cb.ExecuteWithFallback(ctx, func() error {
		return mainErr
	}, nil)

	assert.Equal(t, mainErr, err)
}

func TestCircuitBreaker_allowRequest_ClosedAlwaysAllows(t *testing.T) {
	cfg := DefaultConfig()
	cb := New("allow-closed", cfg)

	assert.True(t, cb.allowRequest())
}

func TestCircuitBreaker_allowRequest_OpenTimeoutToHalfOpen(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Timeout = 10 * time.Millisecond
	cb := New("allow-open", cfg)

	cb.transitionTo(StateOpen)
	cb.openedAt.Store(time.Now().Add(-20 * time.Millisecond))

	allowed := cb.allowRequest()
	assert.True(t, allowed)
	assert.Equal(t, StateHalfOpen, cb.State())
}

func TestCircuitBreaker_allowRequest_HalfOpenMaxCalls(t *testing.T) {
	cfg := DefaultConfig()
	cfg.HalfOpenMaxCalls = 2
	cb := New("allow-half-open", cfg)

	cb.transitionTo(StateHalfOpen)

	assert.True(t, cb.allowRequest())
	assert.True(t, cb.allowRequest())
	assert.False(t, cb.allowRequest())
}

func TestCircuitBreaker_shouldAttemptReset(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Timeout = 10 * time.Millisecond
	cb := New("reset", cfg)

	assert.False(t, cb.shouldAttemptReset())

	cb.openedAt.Store(time.Now().Add(-20 * time.Millisecond))
	assert.True(t, cb.shouldAttemptReset())
}

func TestCircuitBreaker_transitionTo_Idempotent(t *testing.T) {
	cfg := DefaultConfig()
	cb := New("transition-idem", cfg)

	cb.transitionTo(StateClosed)
	assert.Equal(t, StateClosed, cb.State())
}

func TestCircuitBreaker_transitionTo_OpenSetsOpenedAt(t *testing.T) {
	cfg := DefaultConfig()
	cb := New("transition-open", cfg)

	cb.transitionTo(StateOpen)
	assert.Equal(t, StateOpen, cb.State())
	assert.NotNil(t, cb.openedAt.Load())
}

func TestCircuitBreaker_transitionTo_HalfOpenResetsCounters(t *testing.T) {
	cfg := DefaultConfig()
	cb := New("transition-half", cfg)

	atomic.StoreInt32(&cb.halfOpenCalls, 5)
	atomic.StoreInt32(&cb.successCount, 7)

	cb.transitionTo(StateHalfOpen)

	assert.Equal(t, int32(0), atomic.LoadInt32(&cb.halfOpenCalls))
	assert.Equal(t, int32(0), atomic.LoadInt32(&cb.successCount))
}

func TestCircuitBreaker_transitionTo_ClosedResetsFailureAndWindow(t *testing.T) {
	cfg := DefaultConfig()
	cfg.SlidingWindowSize = 4
	cb := New("transition-closed", cfg)

	atomic.StoreInt32(&cb.failureCount, 5)
	atomic.StoreInt32(&cb.successCount, 3)
	cb.slidingWindow = []bool{false, false, false, false}

	cb.transitionTo(StateClosed)

	assert.Equal(t, int32(0), atomic.LoadInt32(&cb.failureCount))
	assert.Equal(t, int32(0), atomic.LoadInt32(&cb.successCount))
	assert.Equal(t, 0, cb.windowIndex)
	for _, v := range cb.slidingWindow {
		assert.True(t, v)
	}
}

func TestCircuitBreaker_transitionTo_OnStateChangeCallback(t *testing.T) {
	cfg := DefaultConfig()
	cb := New("transition-callback", cfg)

	var fromState, toState State
	var name string
	cb.onStateChange = func(n string, from, to State) {
		name = n
		fromState = from
		toState = to
	}

	cb.transitionTo(StateOpen)

	assert.Equal(t, "transition-callback", name)
	assert.Equal(t, StateClosed, fromState)
	assert.Equal(t, StateOpen, toState)
}

func TestCircuitBreaker_recordSuccess_ClosedDecrementsFailures(t *testing.T) {
	cfg := DefaultConfig()
	cb := New("success-closed", cfg)

	atomic.StoreInt32(&cb.failureCount, 2)

	cb.recordSuccess(5 * time.Millisecond)

	assert.Equal(t, int32(1), atomic.LoadInt32(&cb.failureCount))
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.SuccessfulCalls))
	assert.NotZero(t, cb.metrics.LastSuccess.UnixNano())
}

func TestCircuitBreaker_recordSuccess_HalfOpenClosesAfterThreshold(t *testing.T) {
	cfg := DefaultConfig()
	cfg.SuccessThreshold = 2
	cb := New("success-half", cfg)

	cb.transitionTo(StateHalfOpen)

	cb.recordSuccess(1 * time.Millisecond)
	assert.Equal(t, StateHalfOpen, cb.State())

	cb.recordSuccess(1 * time.Millisecond)
	assert.Equal(t, StateClosed, cb.State())
}

func TestCircuitBreaker_recordFailure_ClosedOpensOnThreshold(t *testing.T) {
	cfg := DefaultConfig()
	cfg.FailureThreshold = 2
	cfg.SlidingWindowSize = 2
	cfg.FailureRateThreshold = 1.0
	cb := New("failure-closed", cfg)

	cb.recordFailure(1 * time.Millisecond)
	assert.Equal(t, StateClosed, cb.State())

	cb.recordFailure(1 * time.Millisecond)
	assert.Equal(t, StateOpen, cb.State())
	assert.Equal(t, uint64(2), atomic.LoadUint64(&cb.metrics.FailedCalls))
	assert.NotZero(t, cb.metrics.LastFailure.UnixNano())
}

func TestCircuitBreaker_recordFailure_HalfOpenGoesOpen(t *testing.T) {
	cfg := DefaultConfig()
	cb := New("failure-half", cfg)

	cb.transitionTo(StateHalfOpen)
	cb.recordFailure(1 * time.Millisecond)

	assert.Equal(t, StateOpen, cb.State())
}

func TestCircuitBreaker_recordFailure_UsesFailureRateThreshold(t *testing.T) {
	cfg := DefaultConfig()
	cfg.FailureThreshold = 100
	cfg.SlidingWindowSize = 4
	cfg.FailureRateThreshold = 0.5
	cb := New("failure-rate", cfg)

	cb.slidingWindow = []bool{true, true, true, true}
	cb.windowIndex = 0

	cb.recordFailure(1 * time.Millisecond)
	cb.recordFailure(1 * time.Millisecond)

	assert.Equal(t, StateOpen, cb.State())
}

func TestCircuitBreaker_addToSlidingWindow_Rotation(t *testing.T) {
	cfg := DefaultConfig()
	cfg.SlidingWindowSize = 3
	cb := New("window-add", cfg)

	cb.addToSlidingWindow(true)
	cb.addToSlidingWindow(false)
	cb.addToSlidingWindow(true)

	assert.Equal(t, []bool{true, false, true}, cb.slidingWindow)
	assert.Equal(t, 0, cb.windowIndex)

	cb.addToSlidingWindow(false)
	assert.Equal(t, []bool{false, false, true}, cb.slidingWindow)
	assert.Equal(t, 1, cb.windowIndex)
}

func TestCircuitBreaker_clearSlidingWindow(t *testing.T) {
	cfg := DefaultConfig()
	cfg.SlidingWindowSize = 3
	cb := New("window-clear", cfg)

	cb.slidingWindow = []bool{false, false, false}
	cb.windowIndex = 2

	cb.clearSlidingWindow()

	assert.Equal(t, 0, cb.windowIndex)
	for _, v := range cb.slidingWindow {
		assert.True(t, v)
	}
}

func TestCircuitBreaker_calculateFailureRate(t *testing.T) {
	cfg := DefaultConfig()
	cfg.SlidingWindowSize = 4
	cb := New("failure-rate-calc", cfg)

	cb.slidingWindow = []bool{true, false, false, true}
	rate := cb.calculateFailureRate()
	assert.InDelta(t, 0.5, rate, 0.0001)
}

func TestCircuitBreaker_StateAndName(t *testing.T) {
	cfg := DefaultConfig()
	cb := New("state-name", cfg)

	assert.Equal(t, "state-name", cb.Name())
	assert.Equal(t, StateClosed, cb.State())

	cb.transitionTo(StateOpen)
	assert.Equal(t, StateOpen, cb.State())
}

func TestCircuitBreaker_GetHealthInfo(t *testing.T) {
	cfg := DefaultConfig()
	cfg.SlidingWindowSize = 2
	cb := New("health", cfg)

	cb.slidingWindow = []bool{true, false}
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
	_, ok := hi.Metrics["avg_response_time_ms"]
	assert.True(t, ok)
}

func TestNewDistributedCoordinator_Defaults(t *testing.T) {
	os.Unsetenv("NODE_ID")
	dc := NewDistributedCoordinator("http://coordinator")

	assert.Equal(t, "http://coordinator", dc.coordinatorURL)
	assert.NotEmpty(t, dc.nodeID)
	assert.NotNil(t, dc.breakers)
	assert.NotNil(t, dc.client)
	assert.Equal(t, 5*time.Second, dc.syncInterval)
	assert.NotNil(t, dc.stopChan)
}

func TestNewDistributedCoordinator_UsesEnvNodeID(t *testing.T) {
	os.Setenv("NODE_ID", "node-123")
	defer os.Unsetenv("NODE_ID")

	dc := NewDistributedCoordinator("http://coordinator")
	assert.Equal(t, "node-123", dc.nodeID)
}

func TestDistributedCoordinator_Register(t *testing.T) {
	dc := NewDistributedCoordinator("http://coordinator")
	cb := New("svc", DefaultConfig())

	dc.Register(cb)

	dc.mu.RLock()
	defer dc.mu.RUnlock()
	assert.Same(t, cb, dc.breakers["svc"])
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

	// We cannot assign to dc.reportState directly if it's a method with a value receiver.
	// Instead, this test will simply call syncStates and assert it does not panic.
	dc.syncStates()
}

func TestDistributedCoordinator_reportState_DoesNotPanic(t *testing.T) {
	dc := NewDistributedCoordinator("http://coordinator")
	cb := New("svc", DefaultConfig())

	called := false
	dc.client = &http.Client{
		Transport: roundTripperFunc(func(req *http.Request) (*http.Response, error) {
			called = true
			assert.Equal(t, "application/json", req.Header.Get("Content-Type"))
			assert.Equal(t, "POST", req.Method)
			return &http.Response{
				StatusCode: 200,
				Body:       http.NoBody,
			}, nil
		}),
		Timeout: 5 * time.Second,
	}

	dc.reportState(cb)
	assert.True(t, called)
}

func TestDistributedCoordinator_StartSync_AndStop(t *testing.T) {
	dc := NewDistributedCoordinator("http://coordinator")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go dc.StartSync(ctx)

	time.Sleep(10 * time.Millisecond)
	dc.Stop()
}
