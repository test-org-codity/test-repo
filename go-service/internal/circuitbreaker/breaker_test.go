package circuitbreaker

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

func TestRingBuffer_AddAndAverage(t *testing.T) {
	rb := NewRingBuffer(3)
	assert.Equal(t, time.Duration(0), rb.Average())

	rb.Add(100 * time.Millisecond)
	assert.Equal(t, 100*time.Millisecond, rb.Average())

	rb.Add(200 * time.Millisecond)
	assert.Equal(t, 150*time.Millisecond, rb.Average())

	rb.Add(300 * time.Millisecond)
	assert.Equal(t, 200*time.Millisecond, rb.Average())

	rb.Add(400 * time.Millisecond)
	assert.Equal(t, 300*time.Millisecond, rb.Average())
}

func TestCircuitBreaker_Execute_SuccessAndFailureThresholdOpen(t *testing.T) {
	cfg := Config{
		FailureThreshold:     2,
		SuccessThreshold:     1,
		Timeout:              50 * time.Millisecond,
		HalfOpenMaxCalls:     1,
		SlidingWindowSize:    5,
		FailureRateThreshold: 1.1, // disable rate-based opening
	}
	cb := New("test-exec", cfg)
	ctx := context.Background()

	// success
	err := cb.Execute(ctx, func() error { return nil })
	assert.NoError(t, err)
	assert.Equal(t, StateClosed, cb.State())
	hi := cb.GetHealthInfo()
	assert.Equal(t, uint64(1), hi.Metrics["total_calls"])
	assert.Equal(t, uint64(1), hi.Metrics["successful_calls"])

	// first failure - should not open yet
	err = cb.Execute(ctx, func() error { return assert.AnError })
	assert.Error(t, err)
	assert.Equal(t, StateClosed, cb.State())

	// second failure - should open due to FailureThreshold
	err = cb.Execute(ctx, func() error { return assert.AnError })
	assert.Error(t, err)
	assert.Equal(t, StateOpen, cb.State())

	// while open (and before timeout), request should be rejected
	err = cb.Execute(ctx, func() error { return nil })
	assert.Error(t, err)
	assert.ErrorContains(t, err, "is open")
	hi = cb.GetHealthInfo()
	assert.Equal(t, uint64(1), hi.Metrics["rejected_calls"])
}

func TestCircuitBreaker_OpenToHalfOpenToClosed_OnSuccesses(t *testing.T) {
	cfg := Config{
		FailureThreshold:     1,
		SuccessThreshold:     2,
		Timeout:              20 * time.Millisecond,
		HalfOpenMaxCalls:     3,
		SlidingWindowSize:    3,
		FailureRateThreshold: 1.1, // ignore rate
	}
	cb := New("test-reset", cfg)
	ctx := context.Background()

	// Trigger open
	_ = cb.Execute(ctx, func() error { return assert.AnError })
	assert.Equal(t, StateOpen, cb.State())

	// Simulate timeout elapsed
	cb.openedAt.Store(time.Now().Add(-cfg.Timeout - time.Millisecond))

	// first allowed call transitions to HalfOpen, success recorded
	err := cb.Execute(ctx, func() error { return nil })
	assert.NoError(t, err)
	assert.Equal(t, StateHalfOpen, cb.State())
}

func TestCircuitBreaker_HalfOpenMaxCalls(t *testing.T) {
	cfg := Config{
		FailureThreshold:     10,
		SuccessThreshold:     100, // prevent closing due to successes
		Timeout:              0,
		HalfOpenMaxCalls:     2,
		SlidingWindowSize:    5,
		FailureRateThreshold: 1.1,
	}
	cb := New("test-half-open-max", cfg)
	cb.transitionTo(StateHalfOpen)

	ctx := context.Background()
	// First two calls should be allowed
	for i := 0; i < 2; i++ {
		err := cb.Execute(ctx, func() error { return nil })
		assert.NoError(t, err)
		assert.Equal(t, StateHalfOpen, cb.State())
	}

	// Third call should be rejected due to HalfOpenMaxCalls
	err := cb.Execute(ctx, func() error { return nil })
	assert.Error(t, err)
	assert.ErrorContains(t, err, "is open")
	hi := cb.GetHealthInfo()
	assert.Equal(t, uint64(1), hi.Metrics["rejected_calls"])
}

func TestCircuitBreaker_HalfOpenFailureTransitionsToOpen(t *testing.T) {
	cfg := Config{
		FailureThreshold:     10,
		SuccessThreshold:     2,
		Timeout:              0,
		HalfOpenMaxCalls:     2,
		SlidingWindowSize:    4,
		FailureRateThreshold: 1.1,
	}
	cb := New("test-half-open-fail", cfg)
	cb.transitionTo(StateHalfOpen)

	ctx := context.Background()
	err := cb.Execute(ctx, func() error { return assert.AnError })
	assert.Error(t, err)
	assert.Equal(t, StateOpen, cb.State())
}

func TestCircuitBreaker_ExecuteWithFallback(t *testing.T) {
	cfg := Config{
		FailureThreshold:     1,
		SuccessThreshold:     1,
		Timeout:              time.Second,
		HalfOpenMaxCalls:     1,
		SlidingWindowSize:    3,
		FailureRateThreshold: 1.1,
	}
	cb := New("test-fallback", cfg)

	// Case 1: breaker open -> fallback called and returns nil
	cb.transitionTo(StateOpen)
	cb.openedAt.Store(time.Now())
	fallbackCalled := false
	err := cb.ExecuteWithFallback(context.Background(),
		func() error { return nil },
		func() error { fallbackCalled = true; return nil },
	)
	assert.NoError(t, err)
	assert.True(t, fallbackCalled)

	// Case 2: primary fails in Closed -> fallback called and returns error
	cb.transitionTo(StateClosed)
	expectedErr := assert.AnError
	fallbackCalled = false
	err = cb.ExecuteWithFallback(context.Background(),
		func() error { return assert.AnError },
		func() error { fallbackCalled = true; return expectedErr },
	)
	assert.Error(t, err)
	assert.Equal(t, expectedErr, err)
	assert.True(t, fallbackCalled)
}

func TestCircuitBreaker_GetOrCreate_ReturnsSameInstance(t *testing.T) {
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
		SuccessThreshold:     1,
		Timeout:              time.Second,
		HalfOpenMaxCalls:     1,
		SlidingWindowSize:    4,
		FailureRateThreshold: 1.0,
	}
	cb := New("health", cfg)
	// Make sliding window neutral
	cb.clearSlidingWindow()

	// One failing call
	_ = cb.Execute(context.Background(), func() error { return assert.AnError })

	hi := cb.GetHealthInfo()
	assert.Equal(t, "health", hi.Name)
	assert.Equal(t, "CLOSED", hi.State)
	assert.Equal(t, 1, hi.FailureCount)
	assert.Equal(t, 0, hi.SuccessCount)
	// Failure rate should be 1/SlidingWindowSize
	assert.Equal(t, 1.0/float64(cfg.SlidingWindowSize), hi.FailureRate)

	// Metrics integrity
	total := hi.Metrics["total_calls"].(uint64)
	success := hi.Metrics["successful_calls"].(uint64)
	failed := hi.Metrics["failed_calls"].(uint64)
	rejected := hi.Metrics["rejected_calls"].(uint64)
	stateChanges := hi.Metrics["state_changes"].(uint64)

	assert.Equal(t, uint64(1), total)
	assert.Equal(t, uint64(0), success)
	assert.Equal(t, uint64(1), failed)
	assert.Equal(t, uint64(0), rejected)
	assert.GreaterOrEqual(t, stateChanges, uint64(0))

	avgMs := hi.Metrics["avg_response_time_ms"].(int64)
	assert.GreaterOrEqual(t, avgMs, int64(0))
}

func TestCircuitBreaker_NameAndState(t *testing.T) {
	cb := New("svc-name", DefaultConfig())
	assert.Equal(t, "svc-name", cb.Name())
	assert.Equal(t, StateClosed, cb.State())
}

func TestDistributedCoordinator_RegisterAndSync_CallsReportState(t *testing.T) {
	var mu sync.Mutex
	callCount := 0
	done := make(chan struct{})

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/circuit-breakers/state" && r.Method == http.MethodPost {
			mu.Lock()
			callCount++
			if callCount >= 1 {
				select {
				case <-done:
				default:
					close(done)
				}
			}
			mu.Unlock()
			w.WriteHeader(http.StatusOK)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()

	dc := NewDistributedCoordinator(server.URL)
	dc.syncInterval = 10 * time.Millisecond

	cb := New("coord", DefaultConfig())
	dc.Register(cb)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go dc.StartSync(ctx)

	select {
	case <-done:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("timeout waiting for coordinator to report state")
	}
	cancel()
}

func TestDistributedCoordinator_Stop(t *testing.T) {
	server := httptest.NewServer(http.NotFoundHandler())
	defer server.Close()

	dc := NewDistributedCoordinator(server.URL)
	dc.syncInterval = 10 * time.Millisecond

	cb := New("coord-stop", DefaultConfig())
	dc.Register(cb)

	done := make(chan struct{})
	go func() {
		dc.StartSync(context.Background())
		close(done)
	}()

	// Stop should cause StartSync to return
	dc.Stop()

	select {
	case <-done:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("StartSync did not stop after Stop()")
	}
}
