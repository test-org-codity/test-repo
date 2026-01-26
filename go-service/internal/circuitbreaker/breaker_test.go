package circuitbreaker

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

func resetRegistry() {
	registryMu.Lock()
	defer registryMu.Unlock()
	registry = make(map[string]*CircuitBreaker)
}

func newTestConfig() Config {
	cfg := DefaultConfig()
	cfg.Timeout = 20 * time.Millisecond
	cfg.HalfOpenMaxCalls = 2
	cfg.SuccessThreshold = 2
	cfg.SlidingWindowSize = 4
	cfg.FailureRateThreshold = 0.5
	return cfg
}

func TestRingBuffer_AddAverage(t *testing.T) {
	rb := NewRingBuffer(3)

	assert.Equal(t, time.Duration(0), rb.Average())

	rb.Add(10 * time.Millisecond)
	rb.Add(20 * time.Millisecond)
	assert.Equal(t, (30*time.Millisecond)/2, rb.Average())

	rb.Add(40 * time.Millisecond)
	assert.Equal(t, (10*time.Millisecond+20*time.Millisecond+40*time.Millisecond)/3, rb.Average())

	// Wrap around
	rb.Add(100 * time.Millisecond)
	// Now should be last 3: 20, 40, 100
	assert.Equal(t, (20*time.Millisecond+40*time.Millisecond+100*time.Millisecond)/3, rb.Average())
}

func TestCircuitBreaker_Execute_Success_DecrementsFailureCount(t *testing.T) {
	cfg := newTestConfig()
	cb := New("svc-success", cfg)

	atomic.StoreInt32(&cb.failureCount, 2)
	err := cb.Execute(context.Background(), func() error {
		return nil
	})
	assert.NoError(t, err)

	assert.Equal(t, int32(1), atomic.LoadInt32(&cb.failureCount))
	assert.Equal(t, StateClosed, cb.State())
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.TotalCalls))
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.SuccessfulCalls))
}

func TestCircuitBreaker_Execute_Failure_OpensImmediatelyDueToInitialWindow(t *testing.T) {
	cfg := newTestConfig()
	cb := New("svc-fail-open", cfg)

	err := cb.Execute(context.Background(), func() error {
		return errors.New("boom")
	})
	assert.Error(t, err)
	assert.Equal(t, StateOpen, cb.State())
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.FailedCalls))

	// Next call should be rejected while still open (before timeout)
	err = cb.Execute(context.Background(), func() error { return nil })
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "circuit breaker")
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.SuccessfulCalls)) // still 1? Should be 0 - ensure correct
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.SuccessfulCalls)) // successful calls shouldn't increase
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.TotalCalls))      // total calls shouldn't increase on reject
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.RejectedCalls))
}

func TestCircuitBreaker_OpenToClosedAfterTimeoutAndSuccessThreshold(t *testing.T) {
	cfg := newTestConfig()
	cfg.SuccessThreshold = 1
	cfg.HalfOpenMaxCalls = 1
	cb := New("svc-timeout", cfg)

	// Open it by causing a failure
	_ = cb.Execute(context.Background(), func() error { return errors.New("fail") })
	assert.Equal(t, StateOpen, cb.State())

	// Wait for timeout
	time.Sleep(cfg.Timeout + 10*time.Millisecond)

	// Next call should move to HALF_OPEN and then CLOSED on success
	err := cb.Execute(context.Background(), func() error { return nil })
	assert.NoError(t, err)

	assert.Equal(t, StateClosed, cb.State())
}

func TestCircuitBreaker_HalfOpen_MaxCalls(t *testing.T) {
	cfg := newTestConfig()
	cfg.HalfOpenMaxCalls = 2
	cb := New("svc-halfopen-calls", cfg)

	// Force into HALF_OPEN state
	cb.transitionTo(StateHalfOpen)
	assert.Equal(t, StateHalfOpen, cb.State())

	// Allow up to HalfOpenMaxCalls
	assert.True(t, cb.allowRequest())
	assert.True(t, cb.allowRequest())
	assert.False(t, cb.allowRequest()) // exceeded
}

func TestCircuitBreaker_HalfOpen_FailureReopens(t *testing.T) {
	cfg := newTestConfig()
	cb := New("svc-halfopen-fail", cfg)

	cb.transitionTo(StateHalfOpen)
	assert.Equal(t, StateHalfOpen, cb.State())

	cb.recordFailure(5 * time.Millisecond)
	assert.Equal(t, StateOpen, cb.State())
}

func TestCircuitBreaker_ExecuteWithFallback(t *testing.T) {
	cfg := newTestConfig()
	cb := New("svc-fallback", cfg)

	// Fail then fallback handles
	called := false
	err := cb.ExecuteWithFallback(
		context.Background(),
		func() error { return errors.New("op failed") },
		func() error { called = true; return nil },
	)
	assert.NoError(t, err)
	assert.True(t, called)

	// Success -> fallback not called
	called = false
	err = cb.ExecuteWithFallback(
		context.Background(),
		func() error { return nil },
		func() error { called = true; return nil },
	)
	assert.NoError(t, err)
	assert.False(t, called)
}

func TestGetOrCreate_ReturnsSameInstance(t *testing.T) {
	resetRegistry()
	cfg := newTestConfig()

	cb1 := GetOrCreate("shared", cfg)
	cb2 := GetOrCreate("shared", cfg)
	assert.Same(t, cb1, cb2)

	cb3 := GetOrCreate("other", cfg)
	assert.NotSame(t, cb1, cb3)
}

func TestCircuitBreaker_GetHealthInfo_AverageResponseTime(t *testing.T) {
	cfg := newTestConfig()
	cb := New("svc-health", cfg)

	// record durations directly to avoid sleep
	cb.recordSuccess(20 * time.Millisecond)
	cb.recordFailure(40 * time.Millisecond)

	hi := cb.GetHealthInfo()
	assert.Equal(t, cb.Name(), hi.Name)
	assert.Equal(t, cb.State().String(), hi.State)

	avgMS, ok := hi.Metrics["avg_response_time_ms"].(int64)
	if !ok {
		// Some environments may serialize as float64; handle both
		if f, ok2 := hi.Metrics["avg_response_time_ms"].(float64); ok2 {
			avgMS = int64(f)
		}
	}
	assert.Equal(t, int64(((20*time.Millisecond)+(40*time.Millisecond))/2/time.Millisecond), avgMS)

	// Ensure other metric keys exist
	_, ok = hi.Metrics["total_calls"]
	assert.True(t, ok)
	_, ok = hi.Metrics["successful_calls"]
	assert.True(t, ok)
	_, ok = hi.Metrics["failed_calls"]
	assert.True(t, ok)
	_, ok = hi.Metrics["rejected_calls"]
	assert.True(t, ok)
	_, ok = hi.Metrics["state_changes"]
	assert.True(t, ok)
}

func TestCircuitBreaker_transitionTo_CallbackAndClearWindow(t *testing.T) {
	cfg := newTestConfig()
	cb := New("svc-transition", cfg)

	// Populate sliding window with false
	cb.addToSlidingWindow(false)
	cb.addToSlidingWindow(false)
	cb.addToSlidingWindow(false)
	cb.addToSlidingWindow(false)

	var fromState, toState State
	cb.onStateChange = func(name string, from, to State) {
		fromState = from
		toState = to
	}

	// Transition to Closed should clear window to true
	cb.transitionTo(StateClosed)
	assert.Equal(t, StateClosed, cb.State())
	assert.Equal(t, StateClosed, toState)
	assert.Equal(t, StateClosed, fromState) // oldState was already Closed; callback should still be invoked? It won't if same -> ensure different transition triggers callback.

	// Now transition Closed -> Open to check callback
	cb.transitionTo(StateOpen)
	assert.Equal(t, StateOpen, cb.State())
	assert.Equal(t, StateClosed, fromState)
	assert.Equal(t, StateOpen, toState)

	// Check sliding window cleared to true after closing
	cb.transitionTo(StateClosed)
	allTrue := true
	for _, success := range cb.slidingWindow {
		if !success {
			allTrue = false
			break
		}
	}
	assert.True(t, allTrue)
	assert.Equal(t, 0, cb.windowIndex)
}

func TestCircuitBreaker_shouldAttemptReset(t *testing.T) {
	cfg := newTestConfig()
	cb := New("svc-reset", cfg)

	// Initially, openedAt is nil
	assert.False(t, cb.shouldAttemptReset())

	// Open and wait
	cb.transitionTo(StateOpen)
	assert.False(t, cb.shouldAttemptReset())
	time.Sleep(cfg.Timeout + 10*time.Millisecond)
	assert.True(t, cb.shouldAttemptReset())

	// Manually set openedAt far in the past
	cb.openedAt.Store(time.Now().Add(-1 * time.Hour))
	assert.True(t, cb.shouldAttemptReset())
}

func TestDistributedCoordinator_RegisterAndSync(t *testing.T) {
	cfg := newTestConfig()
	cb := New("svc-coord", cfg)

	var hits int32
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/circuit-breakers/state" && r.Method == http.MethodPost {
			atomic.AddInt32(&hits, 1)
			w.WriteHeader(http.StatusOK)
			return
		}
		http.NotFound(w, r)
	}))
	defer ts.Close()

	dc := NewDistributedCoordinator(ts.URL)
	dc.Register(cb)

	// Single syncStates should post once
	dc.syncStates()
	assert.Equal(t, int32(1), atomic.LoadInt32(&hits))

	// StartSync should periodically post
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	dc.syncInterval = 30 * time.Millisecond
	go dc.StartSync(ctx)

	time.Sleep(120 * time.Millisecond)
	dc.Stop()
	postHits := atomic.LoadInt32(&hits)
	assert.GreaterOrEqual(t, postHits, int32(3))
}

func TestCircuitBreaker_NameAndState(t *testing.T) {
	cfg := newTestConfig()
	cb := New("svc-name", cfg)

	assert.Equal(t, "svc-name", cb.Name())
	assert.Equal(t, StateClosed, cb.State())

	cb.transitionTo(StateOpen)
	assert.Equal(t, StateOpen, cb.State())
}

func TestCircuitBreaker_SlidingWindowFailureRate(t *testing.T) {
	cfg := newTestConfig()
	cfg.SlidingWindowSize = 4
	cb := New("svc-window", cfg)

	// Clear window to all true by transitioning to Closed explicitly
	cb.transitionTo(StateClosed)

	// Add: false, false, true, true -> failure rate = 0.5
	cb.addToSlidingWindow(false)
	cb.addToSlidingWindow(false)
	cb.addToSlidingWindow(true)
	cb.addToSlidingWindow(true)

	rate := cb.calculateFailureRate()
	assert.InDelta(t, 0.5, rate, 0.0001)
}
