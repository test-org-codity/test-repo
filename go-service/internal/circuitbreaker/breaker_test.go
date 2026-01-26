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

func setSlidingWindowAllTrue(cb *CircuitBreaker) {
	cb.windowMu.Lock()
	defer cb.windowMu.Unlock()
	for i := range cb.slidingWindow {
		cb.slidingWindow[i] = true
	}
	cb.windowIndex = 0
}

func TestState_String(t *testing.T) {
	assert.Equal(t, "CLOSED", StateClosed.String())
	assert.Equal(t, "OPEN", StateOpen.String())
	assert.Equal(t, "HALF_OPEN", StateHalfOpen.String())
	assert.Equal(t, "UNKNOWN", State(999).String())
}

func TestRingBuffer_AddAverage(t *testing.T) {
	rb := NewRingBuffer(3)
	assert.Equal(t, time.Duration(0), rb.Average())

	rb.Add(10 * time.Millisecond)
	rb.Add(20 * time.Millisecond)
	rb.Add(30 * time.Millisecond)
	assert.Equal(t, 20*time.Millisecond, rb.Average())

	// Overwrite oldest
	rb.Add(40 * time.Millisecond)
	assert.Equal(t, 30*time.Millisecond, rb.Average())
}

func TestCircuitBreaker_NewAndGetOrCreate_SameInstance(t *testing.T) {
	resetRegistry()
	cfg := DefaultConfig()
	cb1 := GetOrCreate("svc-a", cfg)
	cb2 := GetOrCreate("svc-a", cfg)
	cb3 := GetOrCreate("svc-b", cfg)

	assert.Same(t, cb1, cb2)
	assert.NotSame(t, cb1, cb3)
}

func TestCircuitBreaker_Execute_SuccessAndFailureTransitions(t *testing.T) {
	cfg := DefaultConfig()
	cfg.FailureThreshold = 2
	cfg.SuccessThreshold = 10
	cfg.SlidingWindowSize = 4
	cfg.FailureRateThreshold = 0.75
	cfg.Timeout = 50 * time.Millisecond

	cb := New("svc-exec", cfg)
	setSlidingWindowAllTrue(cb)

	// Success case
	err := cb.Execute(context.Background(), func() error { return nil })
	assert.NoError(t, err)
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.TotalCalls))
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.SuccessfulCalls))
	assert.Equal(t, StateClosed, cb.State())

	// First failure: should remain CLOSED
	err = cb.Execute(context.Background(), func() error { return errors.New("fail1") })
	assert.Error(t, err)
	assert.Equal(t, uint64(2), atomic.LoadUint64(&cb.metrics.TotalCalls))
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.FailedCalls))
	assert.Equal(t, int32(1), atomic.LoadInt32(&cb.failureCount))
	assert.Equal(t, StateClosed, cb.State())

	// Second failure: should transition to OPEN by failure threshold
	err = cb.Execute(context.Background(), func() error { return errors.New("fail2") })
	assert.Error(t, err)
	assert.Equal(t, uint64(3), atomic.LoadUint64(&cb.metrics.TotalCalls))
	assert.Equal(t, uint64(2), atomic.LoadUint64(&cb.metrics.FailedCalls))
	assert.Equal(t, StateOpen, cb.State())
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.StateChanges)) // CLOSED -> OPEN
}

func TestCircuitBreaker_OpenState_RejectionAndResetToHalfOpen(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Timeout = 30 * time.Millisecond
	cfg.HalfOpenMaxCalls = 2
	cfg.SuccessThreshold = 10 // avoid closing in half-open
	cfg.SlidingWindowSize = 5
	cfg.FailureRateThreshold = 0.8

	cb := New("svc-open", cfg)
	setSlidingWindowAllTrue(cb)

	// Force open
	cb.transitionTo(StateOpen)
	assert.Equal(t, StateOpen, cb.State())

	// While open (before timeout), requests should be rejected
	err := cb.Execute(context.Background(), func() error { return nil })
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "is open")
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.RejectedCalls))

	// After timeout, first attempt should transition to HALF_OPEN and allow the call
	time.Sleep(cfg.Timeout + 10*time.Millisecond)
	err = cb.Execute(context.Background(), func() error { return nil })
	assert.NoError(t, err)
	assert.Equal(t, StateHalfOpen, cb.State())
}

func TestCircuitBreaker_HalfOpen_MaxCallsLimit(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Timeout = 10 * time.Millisecond
	cfg.HalfOpenMaxCalls = 1
	cfg.SuccessThreshold = 5 // avoid closing
	cfg.SlidingWindowSize = 5

	cb := New("svc-half-max", cfg)
	setSlidingWindowAllTrue(cb)

	// Enter OPEN then wait to allow HALF_OPEN
	cb.transitionTo(StateOpen)
	time.Sleep(cfg.Timeout + 5*time.Millisecond)

	// First call allowed (transitions to HALF_OPEN inside allowRequest)
	err := cb.Execute(context.Background(), func() error { return nil })
	assert.NoError(t, err)
	assert.Equal(t, StateHalfOpen, cb.State())

	// Second call should still be allowed because the counter starts at 0 when entering HALF_OPEN.
	err = cb.Execute(context.Background(), func() error { return nil })
	assert.NoError(t, err)
	assert.Equal(t, StateHalfOpen, cb.State())

	// Third call should be rejected due to max calls limit.
	// Guard Contains() on non-nil error to avoid nil-pointer dereference on failure.
	err = cb.Execute(context.Background(), func() error { return nil })
	if assert.Error(t, err) {
		assert.Contains(t, err.Error(), "is open")
	}
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.RejectedCalls))
}

func TestCircuitBreaker_HalfOpen_FailureReopens(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Timeout = 10 * time.Millisecond
	cfg.HalfOpenMaxCalls = 3
	cfg.SuccessThreshold = 3
	cfg.SlidingWindowSize = 5

	cb := New("svc-half-fail", cfg)
	setSlidingWindowAllTrue(cb)

	cb.transitionTo(StateOpen)
	time.Sleep(cfg.Timeout + 5*time.Millisecond)

	// First call allowed (moves to HALF_OPEN)
	err := cb.Execute(context.Background(), func() error { return errors.New("trial fail") })
	assert.Error(t, err)
	assert.Equal(t, StateOpen, cb.State()) // Failure in HALF_OPEN should reopen
}

func TestCircuitBreaker_ExecuteWithFallback(t *testing.T) {
	cfg := DefaultConfig()
	cfg.SlidingWindowSize = 10
	cfg.FailureRateThreshold = 0.9 // avoid opening on first failure by rate
	cb := New("svc-fallback", cfg)
	setSlidingWindowAllTrue(cb)

	primaryErr := errors.New("primary failed")
	fallbackCalled := false
	err := cb.ExecuteWithFallback(context.Background(),
		func() error { return primaryErr },
		func() error { fallbackCalled = true; return nil },
	)
	assert.NoError(t, err)
	assert.True(t, fallbackCalled)
}

func TestCircuitBreaker_GetHealthInfo(t *testing.T) {
	cfg := DefaultConfig()
	cfg.SlidingWindowSize = 6
	cfg.FailureRateThreshold = 0.9
	cb := New("svc-health", cfg)
	setSlidingWindowAllTrue(cb)

	// Perform some calls
	_ = cb.Execute(context.Background(), func() error { return nil })
	_ = cb.Execute(context.Background(), func() error { return errors.New("x") })
	_ = cb.Execute(context.Background(), func() error { return nil })

	hi := cb.GetHealthInfo()
	assert.Equal(t, cb.Name(), hi.Name)
	assert.Equal(t, cb.State().String(), hi.State)
	assert.GreaterOrEqual(t, hi.FailureCount, 0)
	assert.GreaterOrEqual(t, hi.SuccessCount, 0)
	assert.InDelta(t, cb.calculateFailureRate(), hi.FailureRate, 1e-9)

	// Metrics fields present and coherent
	if v, ok := hi.Metrics["total_calls"].(uint64); ok {
		assert.Equal(t, atomic.LoadUint64(&cb.metrics.TotalCalls), v)
	} else {
		t.Fatalf("total_calls metric missing or wrong type")
	}
	if v, ok := hi.Metrics["successful_calls"].(uint64); ok {
		assert.Equal(t, atomic.LoadUint64(&cb.metrics.SuccessfulCalls), v)
	} else {
		t.Fatalf("successful_calls metric missing or wrong type")
	}
	if v, ok := hi.Metrics["failed_calls"].(uint64); ok {
		assert.Equal(t, atomic.LoadUint64(&cb.metrics.FailedCalls), v)
	} else {
		t.Fatalf("failed_calls metric missing or wrong type")
	}
	if v, ok := hi.Metrics["rejected_calls"].(uint64); ok {
		assert.Equal(t, atomic.LoadUint64(&cb.metrics.RejectedCalls), v)
	} else {
		t.Fatalf("rejected_calls metric missing or wrong type")
	}
	if v, ok := hi.Metrics["state_changes"].(uint64); ok {
		assert.Equal(t, atomic.LoadUint64(&cb.metrics.StateChanges), v)
	} else {
		t.Fatalf("state_changes metric missing or wrong type")
	}
	if v, ok := hi.Metrics["avg_response_time_ms"].(int64); ok {
		assert.GreaterOrEqual(t, v, int64(0))
	} else {
		t.Fatalf("avg_response_time_ms metric missing or wrong type")
	}
}

func TestCircuitBreaker_OnStateChange_CallbackAndMetrics(t *testing.T) {
	cfg := DefaultConfig()
	cb := New("svc-callback", cfg)

	type trans struct {
		from State
		to   State
	}
	var transitions []trans
	cb.onStateChange = func(name string, from, to State) {
		transitions = append(transitions, trans{from, to})
	}

	cb.transitionTo(StateOpen)
	cb.transitionTo(StateHalfOpen)

	assert.Len(t, transitions, 2)
	assert.Equal(t, StateClosed, transitions[0].from)
	assert.Equal(t, StateOpen, transitions[0].to)
	assert.Equal(t, StateOpen, transitions[1].from)
	assert.Equal(t, StateHalfOpen, transitions[1].to)
	assert.Equal(t, uint64(2), atomic.LoadUint64(&cb.metrics.StateChanges))
}

func TestDistributedCoordinator_ReportStateAndSync(t *testing.T) {
	var callCount int32
	var lastMethod, lastPath string

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&callCount, 1)
		lastMethod = r.Method
		lastPath = r.URL.Path
		assert.Equal(t, "application/json", r.Header.Get("Content-Type"))
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	dc := NewDistributedCoordinator(srv.URL)
	cb1 := New("svc-1", DefaultConfig())
	cb2 := New("svc-2", DefaultConfig())
	dc.Register(cb1)
	dc.Register(cb2)

	dc.syncStates()
	assert.Equal(t, int32(2), atomic.LoadInt32(&callCount))
	assert.Equal(t, "POST", lastMethod)
	assert.Equal(t, "/circuit-breakers/state", lastPath)
}

func TestDistributedCoordinator_StartSyncAndStop(t *testing.T) {
	var callCount int32

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&callCount, 1)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	dc := NewDistributedCoordinator(srv.URL)
	dc.syncInterval = 10 * time.Millisecond

	cb := New("svc-sync", DefaultConfig())
	dc.Register(cb)

	done := make(chan struct{})
	go func() {
		dc.StartSync(ctx)
		close(done)
	}()

	// Wait for at least one sync tick
	time.Sleep(40 * time.Millisecond)
	cancel()

	select {
	case <-done:
	case <-time.After(200 * time.Millisecond):
		t.Fatal("StartSync did not stop after context cancellation")
	}

	assert.GreaterOrEqual(t, atomic.LoadInt32(&callCount), int32(1))
}

func TestCircuitBreaker_NameAndState(t *testing.T) {
	cb := New("svc-name-state", DefaultConfig())
	assert.Equal(t, "svc-name-state", cb.Name())
	assert.Equal(t, StateClosed, cb.State())

	cb.transitionTo(StateOpen)
	assert.Equal(t, StateOpen, cb.State())

	cb.transitionTo(StateHalfOpen)
	assert.Equal(t, StateHalfOpen, cb.State())
}
