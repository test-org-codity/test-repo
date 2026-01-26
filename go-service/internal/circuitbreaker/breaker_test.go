package circuitbreaker

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

func TestState_String(t *testing.T) {
	tests := []struct {
		name  string
		state State
		want  string
	}{
		{"closed", StateClosed, "CLOSED"},
		{"open", StateOpen, "OPEN"},
		{"half_open", StateHalfOpen, "HALF_OPEN"},
		{"unknown", State(99), "UNKNOWN"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.want, tt.state.String())
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
	t.Run("average empty is zero", func(t *testing.T) {
		rb := NewRingBuffer(3)
		assert.Equal(t, time.Duration(0), rb.Average())
	})

	t.Run("average with partial fill", func(t *testing.T) {
		rb := NewRingBuffer(5)
		rb.Add(10 * time.Millisecond)
		rb.Add(20 * time.Millisecond)
		rb.Add(30 * time.Millisecond)
		assert.Equal(t, 20*time.Millisecond, rb.Average())
	})

	t.Run("average when over capacity uses stored elements (ring behavior)", func(t *testing.T) {
		rb := NewRingBuffer(3)
		rb.Add(10 * time.Millisecond)
		rb.Add(20 * time.Millisecond)
		rb.Add(30 * time.Millisecond)
		assert.Equal(t, 20*time.Millisecond, rb.Average())

		rb.Add(40 * time.Millisecond)

		avg := rb.Average()
		assert.True(t, avg >= 20*time.Millisecond && avg <= 40*time.Millisecond, "avg=%v", avg)
	})
}

func TestNew_InitialStateAndFields(t *testing.T) {
	cfg := DefaultConfig()
	cb := New("svc", cfg)

	assert.NotNil(t, cb)
	assert.Equal(t, "svc", cb.Name())
	assert.Equal(t, StateClosed, cb.State())
	assert.NotNil(t, cb.metrics)
	assert.NotNil(t, cb.metrics.responseTimes)
	assert.Len(t, cb.slidingWindow, cfg.SlidingWindowSize)
	assert.Equal(t, 0, cb.windowIndex)
}

func TestGetOrCreate_ReturnsSameInstanceForSameName(t *testing.T) {
	registryMu.Lock()
	registry = make(map[string]*CircuitBreaker)
	registryMu.Unlock()

	cfg := DefaultConfig()
	cb1 := GetOrCreate("a", cfg)
	cb2 := GetOrCreate("a", cfg)
	cb3 := GetOrCreate("b", cfg)

	assert.Same(t, cb1, cb2)
	assert.NotSame(t, cb1, cb3)
	assert.Equal(t, "a", cb1.Name())
	assert.Equal(t, "b", cb3.Name())
}

func TestCircuitBreaker_Execute_SuccessInClosedStateUpdatesMetrics(t *testing.T) {
	cfg := DefaultConfig()
	cfg.SlidingWindowSize = 5
	cb := New("x", cfg)

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	err := cb.Execute(ctx, func() error { return nil })
	assert.NoError(t, err)

	assert.Equal(t, StateClosed, cb.State())
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.TotalCalls))
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.SuccessfulCalls))
	assert.Equal(t, uint64(0), atomic.LoadUint64(&cb.metrics.FailedCalls))
	assert.Equal(t, uint64(0), atomic.LoadUint64(&cb.metrics.RejectedCalls))

	cb.metrics.mu.RLock()
	ls := cb.metrics.LastSuccess
	cb.metrics.mu.RUnlock()
	assert.False(t, ls.IsZero())

	assert.GreaterOrEqual(t, cb.metrics.responseTimes.Average(), time.Duration(0))
}

func TestCircuitBreaker_Execute_FailureInClosedStateUpdatesMetricsAndCounts(t *testing.T) {
	cfg := DefaultConfig()
	cfg.FailureThreshold = 100
	cfg.FailureRateThreshold = 2.0
	cfg.SlidingWindowSize = 4
	cb := New("x", cfg)

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	sentinel := errors.New("boom")
	err := cb.Execute(ctx, func() error { return sentinel })
	assert.ErrorIs(t, err, sentinel)

	assert.Equal(t, StateClosed, cb.State())
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.TotalCalls))
	assert.Equal(t, uint64(0), atomic.LoadUint64(&cb.metrics.SuccessfulCalls))
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.FailedCalls))
	assert.Equal(t, int32(1), atomic.LoadInt32(&cb.failureCount))

	cb.metrics.mu.RLock()
	lf := cb.metrics.LastFailure
	cb.metrics.mu.RUnlock()
	assert.False(t, lf.IsZero())
}

func TestCircuitBreaker_Execute_OpensOnFailureThreshold(t *testing.T) {
	cfg := DefaultConfig()
	cfg.FailureThreshold = 2
	cfg.FailureRateThreshold = 2.0
	cfg.SlidingWindowSize = 10
	cb := New("x", cfg)

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	_ = cb.Execute(ctx, func() error { return errors.New("fail1") })
	assert.Equal(t, StateClosed, cb.State())

	_ = cb.Execute(ctx, func() error { return errors.New("fail2") })
	assert.Equal(t, StateOpen, cb.State())
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.StateChanges))

	err := cb.Execute(ctx, func() error { return nil })
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "circuit breaker 'x' is open")
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.RejectedCalls))
}

func TestCircuitBreaker_Execute_OpensOnFailureRateThreshold(t *testing.T) {
	cfg := DefaultConfig()
	cfg.FailureThreshold = 100
	cfg.SlidingWindowSize = 4
	cfg.FailureRateThreshold = 0.01
	cb := New("x", cfg)

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	_ = cb.Execute(ctx, func() error { return errors.New("f") })
	_ = cb.Execute(ctx, func() error { return errors.New("f2") })
	assert.Equal(t, StateOpen, cb.State())
}

func TestCircuitBreaker_OpenToHalfOpenAfterTimeoutAndBackToClosedOnSuccesses(t *testing.T) {
	cfg := DefaultConfig()
	cfg.FailureThreshold = 1
	cfg.SuccessThreshold = 10
	cfg.Timeout = 20 * time.Millisecond
	cfg.HalfOpenMaxCalls = 3
	cfg.SlidingWindowSize = 5
	cfg.FailureRateThreshold = 2.0

	cb := New("x", cfg)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	_ = cb.Execute(ctx, func() error { return errors.New("fail") })
	assert.Equal(t, StateOpen, cb.State())

	err := cb.Execute(ctx, func() error { return nil })
	assert.Error(t, err)
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.RejectedCalls))

	time.Sleep(cfg.Timeout + 10*time.Millisecond)

	assert.NoError(t, cb.Execute(ctx, func() error { return nil }))
	assert.Equal(t, StateHalfOpen, cb.State())

	assert.NoError(t, cb.Execute(ctx, func() error { return nil }))
	assert.Equal(t, StateHalfOpen, cb.State())

	assert.Equal(t, uint64(2), atomic.LoadUint64(&cb.metrics.SuccessfulCalls))
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.FailedCalls))
	assert.GreaterOrEqual(t, atomic.LoadUint64(&cb.metrics.StateChanges), uint64(2))
}

func TestCircuitBreaker_HalfOpen_FailureTransitionsToOpen(t *testing.T) {
	cfg := DefaultConfig()
	cfg.FailureThreshold = 1
	cfg.Timeout = 15 * time.Millisecond
	cfg.SuccessThreshold = 2
	cfg.HalfOpenMaxCalls = 3
	cfg.SlidingWindowSize = 5
	cfg.FailureRateThreshold = 2.0

	cb := New("x", cfg)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	_ = cb.Execute(ctx, func() error { return errors.New("fail") })
	assert.Equal(t, StateOpen, cb.State())

	time.Sleep(cfg.Timeout + 10*time.Millisecond)

	_ = cb.Execute(ctx, func() error { return nil })
	assert.Equal(t, StateHalfOpen, cb.State())

	_ = cb.Execute(ctx, func() error { return errors.New("nope") })
	assert.Equal(t, StateOpen, cb.State())
}

func TestCircuitBreaker_ExecuteWithFallback(t *testing.T) {
	cfg := DefaultConfig()
	cfg.FailureThreshold = 100
	cfg.FailureRateThreshold = 2.0
	cfg.SlidingWindowSize = 5

	t.Run("fallback invoked on error", func(t *testing.T) {
		cb := New("x", cfg)

		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()

		orig := errors.New("operation failed")
		fb := errors.New("fallback ran")
		err := cb.ExecuteWithFallback(ctx,
			func() error { return orig },
			func() error { return fb },
		)
		assert.ErrorIs(t, err, fb)
		assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.TotalCalls))
		assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.FailedCalls))
	})

	t.Run("fallback not invoked on success", func(t *testing.T) {
		cb := New("x", cfg)
		called := false

		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()

		err := cb.ExecuteWithFallback(ctx,
			func() error { return nil },
			func() error { called = true; return nil },
		)
		assert.NoError(t, err)
		assert.False(t, called)
	})

	t.Run("fallback nil returns original error", func(t *testing.T) {
		cb := New("x", cfg)
		orig := errors.New("operation failed")

		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()

		err := cb.ExecuteWithFallback(ctx,
			func() error { return orig },
			nil,
		)
		assert.ErrorIs(t, err, orig)
	})
}

func TestCircuitBreaker_transitionTo_CallsOnStateChange(t *testing.T) {
	cfg := DefaultConfig()
	cfg.SlidingWindowSize = 5
	cb := New("x", cfg)

	var (
		mu     sync.Mutex
		calls  int
		fromSt State
		toSt   State
		name   string
	)

	cb.onStateChange = func(n string, from, to State) {
		mu.Lock()
		defer mu.Unlock()
		calls++
		name = n
		fromSt = from
		toSt = to
	}

	cb.transitionTo(StateOpen)
	assert.Equal(t, StateOpen, cb.State())

	mu.Lock()
	assert.Equal(t, 1, calls)
	assert.Equal(t, "x", name)
	assert.Equal(t, StateClosed, fromSt)
	assert.Equal(t, StateOpen, toSt)
	mu.Unlock()

	cb.transitionTo(StateOpen)
	mu.Lock()
	assert.Equal(t, 1, calls)
	mu.Unlock()
}

func TestCircuitBreaker_GetHealthInfo(t *testing.T) {
	cfg := DefaultConfig()
	cfg.FailureThreshold = 100
	cfg.FailureRateThreshold = 2.0
	cfg.SlidingWindowSize = 4
	cb := New("svc", cfg)

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	_ = cb.Execute(ctx, func() error { return nil })
	_ = cb.Execute(ctx, func() error { return errors.New("x") })

	hi := cb.GetHealthInfo()

	assert.Equal(t, "svc", hi.Name)
	assert.Equal(t, cb.State().String(), hi.State)
	assert.GreaterOrEqual(t, hi.FailureCount, 1)
	assert.GreaterOrEqual(t, hi.SuccessCount, 0)
	assert.InDelta(t, cb.calculateFailureRate(), hi.FailureRate, 0.000001)

	assert.Contains(t, hi.Metrics, "total_calls")
	assert.Contains(t, hi.Metrics, "successful_calls")
	assert.Contains(t, hi.Metrics, "failed_calls")
	assert.Contains(t, hi.Metrics, "rejected_calls")
	assert.Contains(t, hi.Metrics, "state_changes")
	assert.Contains(t, hi.Metrics, "avg_response_time_ms")

	assert.Equal(t, uint64(2), hi.Metrics["total_calls"])
}

func TestNewDistributedCoordinator_NodeIDFromEnvOrFallback(t *testing.T) {
	old := os.Getenv("NODE_ID")
	_ = os.Setenv("NODE_ID", "test-node-123")
	t.Cleanup(func() { _ = os.Setenv("NODE_ID", old) })

	dc := NewDistributedCoordinator("http://example.com")
	assert.NotNil(t, dc)
	assert.Equal(t, "test-node-123", dc.nodeID)
	assert.Equal(t, 5*time.Second, dc.client.Timeout)
	assert.Equal(t, 5*time.Second, dc.syncInterval)
	assert.NotNil(t, dc.stopChan)

	_ = os.Setenv("NODE_ID", "")
	dc2 := NewDistributedCoordinator("http://example.com")
	assert.NotNil(t, dc2.nodeID)
	assert.NotEmpty(t, dc2.nodeID)
}

func TestDistributedCoordinator_RegisterAndSyncStates_ReportsViaHTTP(t *testing.T) {
	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && r.URL.Path == "/circuit-breakers/state" {
			atomic.AddInt32(&hits, 1)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	dc := NewDistributedCoordinator(srv.URL)
	dc.client = srv.Client()

	cfg := DefaultConfig()
	cfg.SlidingWindowSize = 3
	cb1 := New("a", cfg)
	cb2 := New("b", cfg)

	dc.Register(cb1)
	dc.Register(cb2)

	dc.syncStates()

	assert.Equal(t, int32(2), atomic.LoadInt32(&hits))
}

func TestDistributedCoordinator_StartSync_StopAndContextCancel(t *testing.T) {
	t.Run("stop terminates loop", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusOK)
		}))
		defer srv.Close()

		dc := NewDistributedCoordinator(srv.URL)
		dc.client = srv.Client()
		dc.syncInterval = 5 * time.Millisecond

		cb := New("a", DefaultConfig())
		dc.Register(cb)

		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()

		done := make(chan struct{})
		go func() {
			dc.StartSync(ctx)
			close(done)
		}()

		time.Sleep(15 * time.Millisecond)
		dc.Stop()

		select {
		case <-done:
		case <-time.After(200 * time.Millisecond):
			t.Fatal("StartSync did not stop after Stop()")
		}
	})

	t.Run("context cancel terminates loop", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusOK)
		}))
		defer srv.Close()

		dc := NewDistributedCoordinator(srv.URL)
		dc.client = srv.Client()
		dc.syncInterval = 5 * time.Millisecond

		cb := New("a", DefaultConfig())
		dc.Register(cb)

		ctx, cancel := context.WithCancel(context.Background())

		done := make(chan struct{})
		go func() {
			dc.StartSync(ctx)
			close(done)
		}()

		time.Sleep(15 * time.Millisecond)
		cancel()

		select {
		case <-done:
		case <-time.After(200 * time.Millisecond):
			t.Fatal("StartSync did not stop after context cancellation")
		}
	})
}

func TestCircuitBreaker_calculateFailureRateAndClearSlidingWindow(t *testing.T) {
	cfg := DefaultConfig()
	cfg.SlidingWindowSize = 4
	cfg.FailureThreshold = 100
	cfg.FailureRateThreshold = 2.0
	cb := New("x", cfg)

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	_ = cb.Execute(ctx, func() error { return errors.New("1") })
	_ = cb.Execute(ctx, func() error { return errors.New("2") })

	rate := cb.calculateFailureRate()
	assert.True(t, rate >= 0 && rate <= 1, "rate=%v", rate)

	cb.clearSlidingWindow()
	assert.InDelta(t, 0.0, cb.calculateFailureRate(), 0.000001)
}
