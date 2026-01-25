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

func TestState_String(t *testing.T) {
	assert.Equal(t, "CLOSED", StateClosed.String())
	assert.Equal(t, "OPEN", StateOpen.String())
	assert.Equal(t, "HALF_OPEN", StateHalfOpen.String())
	var unknown State = 99
	assert.Equal(t, "UNKNOWN", unknown.String())
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

func TestNewCircuitBreaker_InitialState(t *testing.T) {
	cfg := DefaultConfig()
	cfg.SlidingWindowSize = 4
	cb := New("test", cfg)
	assert.Equal(t, "test", cb.Name())
	assert.Equal(t, StateClosed, cb.State())
	assert.NotNil(t, cb.metrics)
	assert.NotNil(t, cb.metrics.responseTimes)
	assert.Equal(t, cfg.SlidingWindowSize, len(cb.slidingWindow))
}

func TestGetOrCreate_ReturnsSameInstance(t *testing.T) {
	cfg := DefaultConfig()
	name := "get-or-create-same"
	cb1 := GetOrCreate(name, cfg)
	cb2 := GetOrCreate(name, cfg)
	assert.Same(t, cb1, cb2)
}

func TestRingBuffer_AddAndAverage(t *testing.T) {
	rb := NewRingBuffer(3)
	assert.Equal(t, time.Duration(0), rb.Average())

	rb.Add(1 * time.Millisecond)
	rb.Add(3 * time.Millisecond)
	assert.Equal(t, 2*time.Millisecond, rb.Average())

	rb.Add(5 * time.Millisecond)
	assert.Equal(t, 3*time.Millisecond, rb.Average())

	// Overwrite oldest
	rb.Add(7 * time.Millisecond)
	// Now the last three values should be 3ms,5ms,7ms => avg = 5ms
	assert.Equal(t, 5*time.Millisecond, rb.Average())
}

func TestExecute_SuccessIncrementsMetrics(t *testing.T) {
	cfg := DefaultConfig()
	cfg.FailureRateThreshold = 2.0 // disable rate trigger for test
	cb := New("exec-success", cfg)

	ctx := context.Background()
	err := cb.Execute(ctx, func() error {
		time.Sleep(1 * time.Millisecond)
		return nil
	})
	assert.NoError(t, err)
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.TotalCalls))
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.SuccessfulCalls))
	assert.Equal(t, StateClosed, cb.State())

	hi := cb.GetHealthInfo()
	assert.Equal(t, "exec-success", hi.Name)
	assert.Equal(t, "CLOSED", hi.State)
	assert.Equal(t, 0, hi.FailureCount)
	assert.GreaterOrEqual(t, hi.Metrics["avg_response_time_ms"].(int64), int64(0))
}

func TestExecute_FailureTransitionsToOpenAfterThreshold(t *testing.T) {
	cfg := DefaultConfig()
	cfg.FailureThreshold = 3
	cfg.FailureRateThreshold = 2.0 // disable rate open by rate
	cfg.SlidingWindowSize = 5
	cb := New("fail-open", cfg)

	ctx := context.Background()
	opErr := errors.New("op failed")
	for i := 0; i < cfg.FailureThreshold; i++ {
		err := cb.Execute(ctx, func() error { return opErr })
		assert.Equal(t, opErr, err)
	}

	assert.Equal(t, StateOpen, cb.State())
	assert.Equal(t, uint64(3), atomic.LoadUint64(&cb.metrics.FailedCalls))
	assert.Equal(t, uint64(3), atomic.LoadUint64(&cb.metrics.TotalCalls))
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.StateChanges))

	// Next call should be rejected (open)
	err := cb.Execute(ctx, func() error { return nil })
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "is open")
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.RejectedCalls))
	// TotalCalls should not change on rejection
	assert.Equal(t, uint64(3), atomic.LoadUint64(&cb.metrics.TotalCalls))
}

func TestExecuteWithFallback_OnError(t *testing.T) {
	cfg := DefaultConfig()
	cfg.FailureRateThreshold = 2.0
	cb := New("fallback-error", cfg)

	ctx := context.Background()
	called := false
	err := cb.ExecuteWithFallback(ctx,
		func() error { return errors.New("primary error") },
		func() error {
			called = true
			return nil
		},
	)
	assert.NoError(t, err)
	assert.True(t, called)
}

func TestExecuteWithFallback_OnOpenBreaker(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Timeout = 10 * time.Second
	cb := New("fallback-open", cfg)

	// Transition to open directly
	cb.transitionTo(StateOpen)

	ctx := context.Background()
	called := false
	err := cb.ExecuteWithFallback(ctx,
		func() error { return nil },
		func() error {
			called = true
			return nil
		},
	)
	assert.NoError(t, err)
	assert.True(t, called)
	// RejectedCalls increments
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.RejectedCalls))
}

func TestHalfOpen_AllowsLimitedCallsAndClosesOnSuccessThreshold(t *testing.T) {
	cfg := DefaultConfig()
	cfg.FailureRateThreshold = 2.0
	cfg.Timeout = 15 * time.Millisecond
	cfg.HalfOpenMaxCalls = 2
	cfg.SuccessThreshold = 2
	cfg.SlidingWindowSize = 4
	cb := New("halfopen-success", cfg)

	// Open the breaker
	for i := 0; i < cfg.FailureThreshold; i++ {
		_ = cb.Execute(context.Background(), func() error { return errors.New("fail") })
	}
	assert.Equal(t, StateOpen, cb.State())

	// Wait for timeout to allow reset
	time.Sleep(cfg.Timeout + 5*time.Millisecond)

	// First call after timeout should transition to half-open and allow
	err := cb.Execute(context.Background(), func() error { return nil })
	assert.NoError(t, err)
	assert.Equal(t, StateHalfOpen, cb.State())

	// Second allowed call in half-open should close on reaching success threshold
	err = cb.Execute(context.Background(), func() error { return nil })
	assert.NoError(t, err)
	assert.Equal(t, StateClosed, cb.State())

	// After closing, failure rate should be reset (all true window)
	assert.Equal(t, 0.0, cb.calculateFailureRate())
}

func TestHalfOpen_FailureTransitionsBackToOpen(t *testing.T) {
	cfg := DefaultConfig()
	cfg.FailureRateThreshold = 2.0
	cfg.Timeout = 15 * time.Millisecond
	cfg.HalfOpenMaxCalls = 2
	cfg.SuccessThreshold = 2
	cb := New("halfopen-fail", cfg)

	// Open the breaker by failures
	for i := 0; i < cfg.FailureThreshold; i++ {
		_ = cb.Execute(context.Background(), func() error { return errors.New("fail") })
	}
	assert.Equal(t, StateOpen, cb.State())

	// Wait timeout to attempt reset
	time.Sleep(cfg.Timeout + 5*time.Millisecond)

	// First call in half-open fails -> should go back to open
	err := cb.Execute(context.Background(), func() error { return errors.New("still failing") })
	assert.Error(t, err)
	assert.Equal(t, StateOpen, cb.State())
}

func TestGetHealthInfo_ReturnsAccurateFields(t *testing.T) {
	cfg := DefaultConfig()
	cfg.FailureRateThreshold = 2.0
	cb := New("health", cfg)

	_ = cb.Execute(context.Background(), func() error { return nil })
	_ = cb.Execute(context.Background(), func() error { return errors.New("x") })

	hi := cb.GetHealthInfo()
	assert.Equal(t, "health", hi.Name)
	assert.Contains(t, []string{"CLOSED", "OPEN", "HALF_OPEN"}, hi.State)
	assert.Equal(t, int(atomic.LoadInt32(&cb.failureCount)), hi.FailureCount)
	assert.Equal(t, int(atomic.LoadInt32(&cb.successCount)), hi.SuccessCount)

	// Metrics keys exist
	assert.NotNil(t, hi.Metrics["total_calls"])
	assert.NotNil(t, hi.Metrics["successful_calls"])
	assert.NotNil(t, hi.Metrics["failed_calls"])
	assert.NotNil(t, hi.Metrics["rejected_calls"])
	assert.NotNil(t, hi.Metrics["state_changes"])
	assert.NotNil(t, hi.Metrics["avg_response_time_ms"])
}

func TestNameAndStateAccessors(t *testing.T) {
	cfg := DefaultConfig()
	cb := New("accessors", cfg)
	assert.Equal(t, "accessors", cb.Name())
	assert.Equal(t, StateClosed, cb.State())
}

func TestDistributedCoordinator_ReportStateAndStartSync(t *testing.T) {
	var reqCount int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/circuit-breakers/state" && r.Method == http.MethodPost {
			atomic.AddInt32(&reqCount, 1)
			w.WriteHeader(http.StatusOK)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()

	dc := NewDistributedCoordinator(server.URL)
	// Speed up sync
	dc.syncInterval = 50 * time.Millisecond
	dc.client.Timeout = 200 * time.Millisecond

	cfg := DefaultConfig()
	cfg.FailureRateThreshold = 2.0
	cb1 := New("svc-1", cfg)
	cb2 := New("svc-2", cfg)

	dc.Register(cb1)
	dc.Register(cb2)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go dc.StartSync(ctx)
	// Let it tick a few times
	time.Sleep(220 * time.Millisecond) // ~4 ticks at 50ms, but timing can vary

	dc.Stop()
	// Allow goroutine to exit
	time.Sleep(60 * time.Millisecond)

	// We expect at least some requests; exact count may vary due to timing
	assert.GreaterOrEqual(t, atomic.LoadInt32(&reqCount), int32(2))
}

func TestAllowRequest_RejectedWhenOpenAndNotTimedOut(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Timeout = 100 * time.Millisecond
	cb := New("open-reject", cfg)

	cb.transitionTo(StateOpen)
	// Immediately attempt; should reject
	err := cb.Execute(context.Background(), func() error { return nil })
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "is open")
}

func TestAllowRequest_AllowsAfterTimeoutTransitionsToHalfOpen(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Timeout = 20 * time.Millisecond
	cfg.HalfOpenMaxCalls = 1
	cb := New("open-allow", cfg)

	cb.transitionTo(StateOpen)
	// Wait until timeout passes
	time.Sleep(cfg.Timeout + 5*time.Millisecond)

	// Next execute should be allowed and transition to half-open
	err := cb.Execute(context.Background(), func() error { return nil })
	assert.NoError(t, err)
	assert.Equal(t, StateHalfOpen, cb.State())
}
