package circuitbreaker

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

func TestState_String(t *testing.T) {
	assert.Equal(t, "CLOSED", StateClosed.String())
	assert.Equal(t, "OPEN", StateOpen.String())
	assert.Equal(t, "HALF_OPEN", StateHalfOpen.String())
	assert.Equal(t, "UNKNOWN", State(999).String())
}

func TestRingBuffer_AddAverage(t *testing.T) {
	rb := NewRingBuffer(3)
	assert.Equal(t, time.Duration(0), rb.Average())

	rb.Add(100 * time.Millisecond)
	rb.Add(200 * time.Millisecond)
	rb.Add(300 * time.Millisecond)
	assert.Equal(t, 200*time.Millisecond, rb.Average())

	// Overwrite oldest (100ms) with 400ms -> average of 200,300,400 = 300ms
	rb.Add(400 * time.Millisecond)
	assert.Equal(t, 300*time.Millisecond, rb.Average())
}

func TestCircuitBreaker_New_Defaults(t *testing.T) {
	cfg := DefaultConfig()
	cb := New("service", cfg)
	assert.NotNil(t, cb)
	assert.Equal(t, "service", cb.Name())
	assert.Equal(t, StateClosed, cb.State())
}

func TestCircuitBreaker_Execute_Success(t *testing.T) {
	cfg := DefaultConfig()
	cb := New("svc-success", cfg)
	err := cb.Execute(context.Background(), func() error {
		return nil
	})
	assert.NoError(t, err)
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.TotalCalls))
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.SuccessfulCalls))
	assert.Equal(t, StateClosed, cb.State())
}

func TestCircuitBreaker_Execute_Failure_OpensOnThreshold(t *testing.T) {
	cfg := Config{
		FailureThreshold:     2,
		SuccessThreshold:     1,
		Timeout:              10 * time.Millisecond,
		HalfOpenMaxCalls:     2,
		SlidingWindowSize:    10,
		FailureRateThreshold: 2.0, // disable rate-based opening for this test
	}
	cb := New("svc-fail-threshold", cfg)
	cb.clearSlidingWindow()

	opErr := errors.New("op failed")
	_ = cb.Execute(context.Background(), func() error { return opErr })
	assert.Equal(t, StateClosed, cb.State())
	_ = cb.Execute(context.Background(), func() error { return opErr })
	assert.Equal(t, StateOpen, cb.State())
	assert.Equal(t, uint64(2), atomic.LoadUint64(&cb.metrics.FailedCalls))
}

func TestCircuitBreaker_Execute_OpenRejectsRequests(t *testing.T) {
	cfg := Config{
		FailureThreshold:     1,
		SuccessThreshold:     1,
		Timeout:              100 * time.Millisecond,
		HalfOpenMaxCalls:     1,
		SlidingWindowSize:    1,
		FailureRateThreshold: 2.0,
	}
	cb := New("svc-open-reject", cfg)
	cb.clearSlidingWindow()

	// Trigger open
	_ = cb.Execute(context.Background(), func() error { return errors.New("fail") })
	assert.Equal(t, StateOpen, cb.State())

	called := int32(0)
	err := cb.Execute(context.Background(), func() error {
		atomic.AddInt32(&called, 1)
		return nil
	})
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "is open")
	assert.Equal(t, int32(0), atomic.LoadInt32(&called))
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.RejectedCalls))
}

func TestCircuitBreaker_ResetToHalfOpenAndCloseOnSuccesses(t *testing.T) {
	cfg := Config{
		FailureThreshold:     1,
		SuccessThreshold:     2,
		Timeout:              10 * time.Millisecond,
		HalfOpenMaxCalls:     5,
		SlidingWindowSize:    5,
		FailureRateThreshold: 2.0,
	}
	cb := New("svc-reset", cfg)
	cb.transitionTo(StateOpen)
	// Simulate timeout elapsed
	cb.openedAt.Store(time.Now().Add(-2 * cfg.Timeout))

	// First call after timeout should transition to HALF_OPEN and allow
	err := cb.Execute(context.Background(), func() error { return nil })
	assert.NoError(t, err)
	assert.Equal(t, StateHalfOpen, cb.State())

	// Second successful call should close the breaker
	err = cb.Execute(context.Background(), func() error { return nil })
	assert.NoError(t, err)
	assert.Equal(t, StateClosed, cb.State())
}

func TestCircuitBreaker_HalfOpenFailureReopens(t *testing.T) {
	cfg := Config{
		FailureThreshold:     2,
		SuccessThreshold:     2,
		Timeout:              10 * time.Millisecond,
		HalfOpenMaxCalls:     2,
		SlidingWindowSize:    4,
		FailureRateThreshold: 2.0,
	}
	cb := New("svc-halfopen-failure", cfg)
	cb.transitionTo(StateOpen)
	cb.openedAt.Store(time.Now().Add(-2 * cfg.Timeout))

	// First probe transitions to HALF_OPEN
	err := cb.Execute(context.Background(), func() error { return errors.New("probe fail") })
	assert.Error(t, err)
	assert.Equal(t, StateOpen, cb.State())
}

func TestCircuitBreaker_ExecuteWithFallback(t *testing.T) {
	cfg := DefaultConfig()
	cb := New("svc-fallback", cfg)

	opErr := errors.New("op fail")
	fallbackCalled := false
	err := cb.ExecuteWithFallback(context.Background(),
		func() error { return opErr },
		func() error {
			fallbackCalled = true
			return nil
		},
	)
	assert.NoError(t, err)
	assert.True(t, fallbackCalled)
}

func TestCircuitBreaker_GetOrCreate_ReturnsSameInstance(t *testing.T) {
	// reset registry for test isolation
	registryMu.Lock()
	registry = make(map[string]*CircuitBreaker)
	registryMu.Unlock()

	cfg := DefaultConfig()
	cb1 := GetOrCreate("shared", cfg)
	cb2 := GetOrCreate("shared", cfg)
	assert.Same(t, cb1, cb2)
}

func TestCircuitBreaker_GetHealthInfo(t *testing.T) {
	cfg := Config{
		FailureThreshold:     10,
		SuccessThreshold:     3,
		Timeout:              1 * time.Second,
		HalfOpenMaxCalls:     3,
		SlidingWindowSize:    4,
		FailureRateThreshold: 0.9,
	}
	cb := New("svc-health", cfg)
	cb.clearSlidingWindow()

	// One failure in CLOSED state to increment failure count and window
	cb.recordFailure(2 * time.Millisecond)

	hi := cb.GetHealthInfo()
	assert.Equal(t, "svc-health", hi.Name)
	assert.Equal(t, "CLOSED", hi.State)
	assert.GreaterOrEqual(t, hi.FailureCount, 1)
	assert.Equal(t, 0, hi.SuccessCount) // successCount increments only in half-open
	assert.InDelta(t, 0.25, hi.FailureRate, 0.0001)

	// Metrics presence
	m := hi.Metrics
	_, ok := m["total_calls"]
	assert.True(t, ok)
	assert.EqualValues(t, 1, m["failed_calls"])
}

func TestDistributedCoordinator_RegisterAndSync(t *testing.T) {
	var hits int32
	var lastPath string

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		lastPath = r.URL.Path
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	dc := NewDistributedCoordinator(srv.URL)
	dc.syncInterval = 20 * time.Millisecond

	cb := New("svc-dist", DefaultConfig())
	dc.Register(cb)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go dc.StartSync(ctx)

	// Allow some sync cycles
	time.Sleep(60 * time.Millisecond)
	dc.Stop()
	time.Sleep(30 * time.Millisecond)

	assert.GreaterOrEqual(t, atomic.LoadInt32(&hits), int32(1))
	assert.Equal(t, "/circuit-breakers/state", lastPath)
}

func TestDistributedCoordinator_NodeIDDefault(t *testing.T) {
	orig := os.Getenv("NODE_ID")
	_ = os.Unsetenv("NODE_ID")
	defer os.Setenv("NODE_ID", orig)

	dc := NewDistributedCoordinator("http://example.com")
	assert.NotEmpty(t, dc.nodeID)
}

func TestCircuitBreaker_allowRequest_HalfOpenMaxCalls(t *testing.T) {
	cfg := Config{
		FailureThreshold:     1,
		SuccessThreshold:     2,
		Timeout:              1 * time.Second,
		HalfOpenMaxCalls:     2,
		SlidingWindowSize:    3,
		FailureRateThreshold: 1.0,
	}
	cb := New("svc-allow", cfg)
	cb.transitionTo(StateHalfOpen)

	assert.True(t, cb.allowRequest())
	assert.True(t, cb.allowRequest())
	assert.False(t, cb.allowRequest())
}

func TestCircuitBreaker_transitionTo_Callback(t *testing.T) {
	cfg := DefaultConfig()
	cb := New("svc-callback", cfg)

	var called bool
	var fromState, toState State
	cb.onStateChange = func(name string, from, to State) {
		called = true
		fromState, toState = from, to
	}

	cb.transitionTo(StateOpen)
	assert.True(t, called)
	assert.Equal(t, StateClosed, fromState)
	assert.Equal(t, StateOpen, toState)
	assert.Equal(t, StateOpen, cb.State())
}

func TestCircuitBreaker_calculateFailureRate_AfterClear(t *testing.T) {
	cfg := Config{
		FailureThreshold:     3,
		SuccessThreshold:     1,
		Timeout:              1 * time.Second,
		HalfOpenMaxCalls:     1,
		SlidingWindowSize:    4,
		FailureRateThreshold: 0.9,
	}
	cb := New("svc-rate", cfg)
	// Initially all false -> failure rate 1.0
	assert.Equal(t, 1.0, cb.calculateFailureRate())

	// After clear -> all true -> 0.0
	cb.clearSlidingWindow()
	assert.Equal(t, 0.0, cb.calculateFailureRate())

	// Add 2 failures and 2 successes -> 0.5
	cb.addToSlidingWindow(false)
	cb.addToSlidingWindow(false)
	cb.addToSlidingWindow(true)
	cb.addToSlidingWindow(true)
	assert.InDelta(t, 0.5, cb.calculateFailureRate(), 0.0001)
}

func TestCircuitBreaker_shouldAttemptReset(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Timeout = 10 * time.Millisecond
	cb := New("svc-reset-check", cfg)

	// Not open yet
	assert.False(t, cb.shouldAttemptReset())

	cb.transitionTo(StateOpen)
	assert.False(t, cb.shouldAttemptReset())

	// Simulate time passing
	cb.openedAt.Store(time.Now().Add(-2 * cfg.Timeout))
	assert.True(t, cb.shouldAttemptReset())
}

func TestCircuitBreaker_NameAndState(t *testing.T) {
	cb := New("svc-name", DefaultConfig())
	assert.Equal(t, "svc-name", cb.Name())
	assert.Equal(t, StateClosed, cb.State())
}
