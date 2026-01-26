package circuitbreaker

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

func newTestCB(name string, cfg Config) *CircuitBreaker {
	cb := New(name, cfg)
	cb.clearSlidingWindow()
	return cb
}

func TestState_String(t *testing.T) {
	assert.Equal(t, "CLOSED", StateClosed.String())
	assert.Equal(t, "OPEN", StateOpen.String())
	assert.Equal(t, "HALF_OPEN", StateHalfOpen.String())
	var s State = 99
	assert.Equal(t, "UNKNOWN", s.String())
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

func TestRingBuffer_AddAverage(t *testing.T) {
	rb := NewRingBuffer(3)
	assert.Equal(t, time.Duration(0), rb.Average())

	rb.Add(10 * time.Millisecond)
	rb.Add(20 * time.Millisecond)
	assert.InDelta(t, (15 * time.Millisecond).Milliseconds(), rb.Average().Milliseconds(), 1)

	// Overwrite and ensure average reflects last 3
	rb.Add(30 * time.Millisecond)
	rb.Add(40 * time.Millisecond)
	// Now should average 20,30,40 => 30
	assert.InDelta(t, (30 * time.Millisecond).Milliseconds(), rb.Average().Milliseconds(), 1)
}

func TestNewAndGetOrCreate(t *testing.T) {
	registryMu.Lock()
	registry = make(map[string]*CircuitBreaker)
	registryMu.Unlock()

	cfg := DefaultConfig()
	cfg.SlidingWindowSize = 5

	cb1 := GetOrCreate("svc", cfg)
	assert.NotNil(t, cb1)
	assert.Equal(t, "svc", cb1.Name())
	assert.Equal(t, StateClosed, cb1.State())
	assert.Equal(t, 5, len(cb1.slidingWindow))

	cb2 := GetOrCreate("svc", cfg)
	assert.Same(t, cb1, cb2)

	cb3 := GetOrCreate("svc2", cfg)
	assert.NotSame(t, cb1, cb3)
	assert.Equal(t, "svc2", cb3.Name())
}

func TestExecute_SuccessUpdatesMetricsAndStaysClosed(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Timeout = 100 * time.Millisecond
	cb := newTestCB("ok", cfg)

	err := cb.Execute(context.Background(), func() error { time.Sleep(10 * time.Millisecond); return nil })
	assert.NoError(t, err)
	assert.Equal(t, StateClosed, cb.State())
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.TotalCalls))
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.SuccessfulCalls))
	assert.Equal(t, uint64(0), atomic.LoadUint64(&cb.metrics.FailedCalls))
	avg := cb.metrics.responseTimes.Average()
	assert.True(t, avg >= 0)
}

func TestExecute_FailureDoesNotOpenWhenThresholdsHigh(t *testing.T) {
	cfg := DefaultConfig()
	cfg.FailureThreshold = 100
	cfg.FailureRateThreshold = 2.0
	cb := newTestCB("no-open", cfg)

	err := cb.Execute(context.Background(), func() error { return assert.AnError })
	assert.Error(t, err)
	assert.Equal(t, StateClosed, cb.State())
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.TotalCalls))
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.FailedCalls))
}

func TestOpenOnFailureThresholdAndRejectFurtherCalls(t *testing.T) {
	cfg := DefaultConfig()
	cfg.FailureThreshold = 2
	cfg.FailureRateThreshold = 2.0
	cfg.Timeout = 200 * time.Millisecond
	cb := newTestCB("trip", cfg)

	// Two failures trigger open
	_ = cb.Execute(context.Background(), func() error { return assert.AnError })
	_ = cb.Execute(context.Background(), func() error { return assert.AnError })
	assert.Equal(t, StateOpen, cb.State())
	assert.Equal(t, uint64(2), atomic.LoadUint64(&cb.metrics.TotalCalls))

	// Further call should be rejected without incrementing TotalCalls
	err := cb.Execute(context.Background(), func() error { return nil })
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "is open")
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.RejectedCalls))
	assert.Equal(t, uint64(2), atomic.LoadUint64(&cb.metrics.TotalCalls))
}

func TestHalfOpenTransitionAndFailureGoesOpen(t *testing.T) {
	cfg := DefaultConfig()
	cfg.FailureThreshold = 1
	cfg.FailureRateThreshold = 2.0
	cfg.Timeout = 10 * time.Millisecond
	cb := newTestCB("half-fail", cfg)

	// Trip to open
	_ = cb.Execute(context.Background(), func() error { return assert.AnError })
	assert.Equal(t, StateOpen, cb.State())

	// Wait for timeout and attempt a request:
	time.Sleep(15 * time.Millisecond)
	// The first call will move to HalfOpen and be allowed; we make it fail to go back Open.
	err := cb.Execute(context.Background(), func() error { return assert.AnError })
	assert.Error(t, err)
	assert.Equal(t, StateOpen, cb.State())
}

func TestHalfOpenCallLimit(t *testing.T) {
	cfg := DefaultConfig()
	cfg.FailureThreshold = 1
	cfg.FailureRateThreshold = 2.0
	cfg.Timeout = 5 * time.Millisecond
	cfg.HalfOpenMaxCalls = 2
	cfg.SuccessThreshold = 100 // avoid closing during test
	cb := newTestCB("half-limit", cfg)

	// Trip to open
	_ = cb.Execute(context.Background(), func() error { return assert.AnError })
	assert.Equal(t, StateOpen, cb.State())

	time.Sleep(10 * time.Millisecond)

	// First two calls allowed in HalfOpen
	err1 := cb.Execute(context.Background(), func() error { return nil })
	err2 := cb.Execute(context.Background(), func() error { return nil })
	assert.NoError(t, err1)
	assert.NoError(t, err2)
	assert.Equal(t, StateHalfOpen, cb.State())

	// Third call should be rejected due to HalfOpenMaxCalls
	err3 := cb.Execute(context.Background(), func() error { return nil })
	assert.Error(t, err3)
	assert.Contains(t, err3.Error(), "is open")
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.RejectedCalls))
}

func TestExecuteWithFallback_OnErrorAndOnOpen(t *testing.T) {
	cfg := DefaultConfig()
	cfg.FailureThreshold = 1
	cfg.FailureRateThreshold = 2.0
	cfg.Timeout = 5 * time.Millisecond
	cb := newTestCB("fallback", cfg)

	// Case 1: operation error triggers fallback
	fallbackCalled := int32(0)
	err := cb.ExecuteWithFallback(context.Background(),
		func() error { return assert.AnError },
		func() error { atomic.AddInt32(&fallbackCalled, 1); return nil },
	)
	assert.NoError(t, err)
	assert.Equal(t, int32(1), atomic.LoadInt32(&fallbackCalled))

	// Now breaker should be open due to threshold
	assert.Equal(t, StateOpen, cb.State())

	// Case 2: open rejection triggers fallback
	time.Sleep(1 * time.Millisecond) // still open, not enough to half-open
	err2 := cb.ExecuteWithFallback(context.Background(),
		func() error { return nil },
		func() error { atomic.AddInt32(&fallbackCalled, 1); return assert.AnError },
	)
	assert.Error(t, err2)
	assert.Equal(t, int32(2), atomic.LoadInt32(&fallbackCalled))
}

func TestGetHealthInfoSnapshot(t *testing.T) {
	cfg := DefaultConfig()
	cfg.SlidingWindowSize = 4
	cb := newTestCB("health", cfg)

	// Set known sliding window: F, F, S, S => failure rate 0.5
	cb.addToSlidingWindow(false)
	cb.addToSlidingWindow(false)
	cb.addToSlidingWindow(true)
	cb.addToSlidingWindow(true)

	// Simulate one call success and one failure to set metrics counters
	_ = cb.Execute(context.Background(), func() error { return nil })
	_ = cb.Execute(context.Background(), func() error { return assert.AnError })

	hi := cb.GetHealthInfo()
	assert.Equal(t, "health", hi.Name)
	assert.Equal(t, cb.State().String(), hi.State)
	assert.Equal(t, int(atomic.LoadInt32(&cb.failureCount)), hi.FailureCount)
	assert.Equal(t, int(atomic.LoadInt32(&cb.successCount)), hi.SuccessCount)
	assert.InDelta(t, 0.5, hi.FailureRate, 0.0001)

	// Metrics map keys are present
	m := hi.Metrics
	assert.Contains(t, m, "total_calls")
	assert.Contains(t, m, "successful_calls")
	assert.Contains(t, m, "failed_calls")
	assert.Contains(t, m, "rejected_calls")
	assert.Contains(t, m, "state_changes")
	assert.Contains(t, m, "avg_response_time_ms")
}

func TestShouldAttemptResetBasedOnTimeout(t *testing.T) {
	cfg := DefaultConfig()
	cfg.FailureThreshold = 1
	cfg.Timeout = 20 * time.Millisecond
	cb := newTestCB("reset", cfg)

	// Trip to open
	_ = cb.Execute(context.Background(), func() error { return assert.AnError })
	assert.Equal(t, StateOpen, cb.State())
	assert.False(t, cb.shouldAttemptReset())

	time.Sleep(25 * time.Millisecond)
	assert.True(t, cb.shouldAttemptReset())
}

func TestClearSlidingWindowResetsFailureRate(t *testing.T) {
	cfg := DefaultConfig()
	cfg.SlidingWindowSize = 4
	cb := New("win", cfg)
	// default window is all false; failure rate should be 1.0
	assert.InDelta(t, 1.0, cb.calculateFailureRate(), 0.0001)

	cb.clearSlidingWindow()
	assert.InDelta(t, 0.0, cb.calculateFailureRate(), 0.0001)
}

func TestOnStateChangeCallback(t *testing.T) {
	cfg := DefaultConfig()
	cfg.FailureThreshold = 1
	cfg.FailureRateThreshold = 2.0
	cb := newTestCB("callback", cfg)

	var fromState, toState State
	cb.onStateChange = func(name string, from, to State) {
		fromState = from
		toState = to
	}

	_ = cb.Execute(context.Background(), func() error { return assert.AnError })
	assert.Equal(t, StateClosed, fromState)
	assert.Equal(t, StateOpen, toState)
}

func TestDistributedCoordinator_StartSyncAndStop(t *testing.T) {
	reqCh := make(chan *http.Request, 10)
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reqCh <- r
		w.WriteHeader(http.StatusOK)
	}))
	defer ts.Close()

	dc := NewDistributedCoordinator(ts.URL)
	dc.syncInterval = 20 * time.Millisecond

	cfg := DefaultConfig()
	cb := newTestCB("svc-sync", cfg)
	dc.Register(cb)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go dc.StartSync(ctx)

	// Expect at least one request
	select {
	case r := <-reqCh:
		assert.Equal(t, "/circuit-breakers/state", r.URL.Path)
		assert.Equal(t, "application/json", r.Header.Get("Content-Type"))
		// Body is nil per implementation
		if r.Body != nil {
			buf := make([]byte, 1)
			n, _ := r.Body.Read(buf)
			assert.Equal(t, 0, n)
		}
	case <-time.After(200 * time.Millisecond):
		t.Fatalf("did not receive sync request in time")
	}

	// Stop syncing
	dc.Stop()
	cancel()
}

func TestExecute_RejectedDoesNotIncrementTotalCalls(t *testing.T) {
	cfg := DefaultConfig()
	cfg.FailureThreshold = 1
	cfg.FailureRateThreshold = 2.0
	cfg.Timeout = time.Second
	cb := newTestCB("reject", cfg)

	// Trip to open
	_ = cb.Execute(context.Background(), func() error { return assert.AnError })
	assert.Equal(t, StateOpen, cb.State())

	// Attempt while open
	totalBefore := atomic.LoadUint64(&cb.metrics.TotalCalls)
	rejectedBefore := atomic.LoadUint64(&cb.metrics.RejectedCalls)
	err := cb.Execute(context.Background(), func() error { return nil })
	assert.Error(t, err)
	assert.True(t, strings.Contains(err.Error(), "is open"))
	assert.Equal(t, totalBefore, atomic.LoadUint64(&cb.metrics.TotalCalls))
	assert.Equal(t, rejectedBefore+1, atomic.LoadUint64(&cb.metrics.RejectedCalls))
}
