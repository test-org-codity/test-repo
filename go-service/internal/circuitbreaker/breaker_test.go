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
		name string
		s    State
		want string
	}{
		{"closed", StateClosed, "CLOSED"},
		{"open", StateOpen, "OPEN"},
		{"halfopen", StateHalfOpen, "HALF_OPEN"},
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
	assert.InEpsilon(t, 0.5, cfg.FailureRateThreshold, 0.000001)
}

func TestRingBuffer_AddAndAverage_Empty(t *testing.T) {
	rb := NewRingBuffer(3)
	assert.NotNil(t, rb)
	assert.Equal(t, time.Duration(0), rb.Average())
}

func TestRingBuffer_AddAndAverage_Partial(t *testing.T) {
	rb := NewRingBuffer(5)
	rb.Add(10 * time.Millisecond)
	rb.Add(20 * time.Millisecond)
	rb.Add(30 * time.Millisecond)

	assert.Equal(t, 20*time.Millisecond, rb.Average())
}

func TestRingBuffer_AddAndAverage_WrapAndCount(t *testing.T) {
	rb := NewRingBuffer(3)
	rb.Add(10 * time.Millisecond)
	rb.Add(20 * time.Millisecond)
	rb.Add(30 * time.Millisecond)
	assert.Equal(t, 20*time.Millisecond, rb.Average())

	// wrap: head moves, count stays at size
	rb.Add(40 * time.Millisecond)

	// Implementation averages indices [0..count-1], not logical order.
	// After wrap, data likely: [40,20,30] -> avg 30ms.
	assert.Equal(t, 30*time.Millisecond, rb.Average())
}

func TestNewCircuitBreaker_InitialStateAndWindow(t *testing.T) {
	cfg := DefaultConfig()
	cfg.SlidingWindowSize = 7

	cb := New("svc", cfg)
	assert.NotNil(t, cb)
	assert.Equal(t, "svc", cb.Name())
	assert.Equal(t, StateClosed, cb.State())
	assert.NotNil(t, cb.metrics)
	assert.NotNil(t, cb.metrics.responseTimes)
	assert.Len(t, cb.slidingWindow, 7)

	// default bools are false, so initial failure rate is 1.0 until successes recorded
	assert.InEpsilon(t, 1.0, cb.calculateFailureRate(), 0.000001)
}

func TestGetOrCreate_ReturnsSameInstance(t *testing.T) {
	registryMu.Lock()
	registry = make(map[string]*CircuitBreaker)
	registryMu.Unlock()

	cfg := DefaultConfig()
	a := GetOrCreate("svcA", cfg)
	b := GetOrCreate("svcA", cfg)
	c := GetOrCreate("svcB", cfg)

	assert.Same(t, a, b)
	assert.NotSame(t, a, c)
	assert.Equal(t, "svcA", a.Name())
	assert.Equal(t, "svcB", c.Name())
}

func TestCircuitBreaker_Execute_Success_RecordsMetrics(t *testing.T) {
	cfg := DefaultConfig()
	cfg.SlidingWindowSize = 5
	cb := New("svc", cfg)

	err := cb.Execute(context.Background(), func() error {
		time.Sleep(5 * time.Millisecond)
		return nil
	})
	assert.NoError(t, err)

	assert.Equal(t, StateClosed, cb.State())
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.TotalCalls))
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.SuccessfulCalls))
	assert.Equal(t, uint64(0), atomic.LoadUint64(&cb.metrics.FailedCalls))
	assert.Equal(t, uint64(0), atomic.LoadUint64(&cb.metrics.RejectedCalls))
	assert.GreaterOrEqual(t, cb.metrics.responseTimes.Average(), time.Duration(0))

	cb.metrics.mu.RLock()
	ls := cb.metrics.LastSuccess
	lf := cb.metrics.LastFailure
	cb.metrics.mu.RUnlock()
	assert.False(t, ls.IsZero())
	assert.True(t, lf.IsZero())
}

func TestCircuitBreaker_Execute_Failure_TransitionsToOpen_ByFailureThreshold(t *testing.T) {
	cfg := DefaultConfig()
	cfg.FailureThreshold = 2
	cfg.FailureRateThreshold = 1.0 // irrelevant
	cfg.SlidingWindowSize = 10
	cb := New("svc", cfg)
	cb.clearSlidingWindow()

	opErr := errors.New("boom")

	err1 := cb.Execute(context.Background(), func() error { return opErr })
	assert.ErrorIs(t, err1, opErr)
	assert.Equal(t, StateClosed, cb.State())

	err2 := cb.Execute(context.Background(), func() error { return opErr })
	assert.ErrorIs(t, err2, opErr)
	assert.Equal(t, StateOpen, cb.State())

	assert.Equal(t, uint64(2), atomic.LoadUint64(&cb.metrics.TotalCalls))
	assert.Equal(t, uint64(0), atomic.LoadUint64(&cb.metrics.SuccessfulCalls))
	assert.Equal(t, uint64(2), atomic.LoadUint64(&cb.metrics.FailedCalls))
	assert.Equal(t, uint64(0), atomic.LoadUint64(&cb.metrics.RejectedCalls))
	assert.GreaterOrEqual(t, atomic.LoadUint64(&cb.metrics.StateChanges), uint64(1))

	cb.metrics.mu.RLock()
	lf := cb.metrics.LastFailure
	cb.metrics.mu.RUnlock()
	assert.False(t, lf.IsZero())
}

func TestCircuitBreaker_Execute_Failure_TransitionsToOpen_ByFailureRateThreshold(t *testing.T) {
	cfg := DefaultConfig()
	cfg.FailureThreshold = 1000
	cfg.SlidingWindowSize = 4
	cfg.FailureRateThreshold = 0.5
	cb := New("svc", cfg)

	// Make window start all successes so failure rate reflects actual failures we add.
	cb.clearSlidingWindow()

	_ = cb.Execute(context.Background(), func() error { return nil })                // success
	_ = cb.Execute(context.Background(), func() error { return errors.New("fail") }) // failure
	assert.Equal(t, StateClosed, cb.State())

	_ = cb.Execute(context.Background(), func() error { return errors.New("fail") }) // failure; now 2 failures in 4 -> 0.5
	assert.Equal(t, StateOpen, cb.State())
	assert.GreaterOrEqual(t, cb.calculateFailureRate(), 0.5)
}

func TestCircuitBreaker_Execute_RejectedWhenOpenAndNotTimedOut(t *testing.T) {
	cfg := DefaultConfig()
	cfg.FailureThreshold = 1
	cfg.Timeout = 250 * time.Millisecond
	cfg.SlidingWindowSize = 5
	cb := New("svc", cfg)
	cb.clearSlidingWindow()

	_ = cb.Execute(context.Background(), func() error { return errors.New("fail") })
	assert.Equal(t, StateOpen, cb.State())

	err := cb.Execute(context.Background(), func() error { return nil })
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "circuit breaker 'svc' is open")
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.RejectedCalls))
}

func TestCircuitBreaker_OpenToHalfOpenAfterTimeout_ThenCloseAfterSuccessThreshold(t *testing.T) {
	cfg := DefaultConfig()
	cfg.FailureThreshold = 1
	cfg.SuccessThreshold = 2
	cfg.HalfOpenMaxCalls = 3
	cfg.Timeout = 20 * time.Millisecond
	cfg.SlidingWindowSize = 5

	cb := New("svc", cfg)
	cb.clearSlidingWindow()

	_ = cb.Execute(context.Background(), func() error { return errors.New("fail") })
	assert.Equal(t, StateOpen, cb.State())

	time.Sleep(cfg.Timeout + 15*time.Millisecond)

	// First allowed call should transition to HALF_OPEN
	err := cb.Execute(context.Background(), func() error { return nil })
	assert.NoError(t, err)
	assert.Equal(t, StateHalfOpen, cb.State())

	// Second success reaches threshold -> CLOSED
	err = cb.Execute(context.Background(), func() error { return nil })
	assert.NoError(t, err)
	assert.Equal(t, StateClosed, cb.State())

	// When closed, halfOpenCalls should no longer matter; should allow
	err = cb.Execute(context.Background(), func() error { return nil })
	assert.NoError(t, err)
	assert.Equal(t, StateClosed, cb.State())
}

func TestCircuitBreaker_HalfOpen_MaxCalls_RejectsAfterLimit(t *testing.T) {
	cfg := DefaultConfig()
	cfg.FailureThreshold = 1
	cfg.Timeout = 10 * time.Millisecond
	cfg.HalfOpenMaxCalls = 2
	cfg.SuccessThreshold = 100
	cfg.SlidingWindowSize = 5

	cb := New("svc", cfg)
	cb.clearSlidingWindow()

	_ = cb.Execute(context.Background(), func() error { return errors.New("fail") })
	assert.Equal(t, StateOpen, cb.State())

	time.Sleep(cfg.Timeout + 10*time.Millisecond)

	// allow 1 -> transitions to half-open
	assert.NoError(t, cb.Execute(context.Background(), func() error { return nil }))
	assert.Equal(t, StateHalfOpen, cb.State())

	// allow 2
	assert.NoError(t, cb.Execute(context.Background(), func() error { return nil }))
	assert.Equal(t, StateHalfOpen, cb.State())

	// third should be rejected
	err := cb.Execute(context.Background(), func() error { return nil })
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "circuit breaker 'svc' is open")
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.RejectedCalls))
}

func TestCircuitBreaker_HalfOpen_FailureTransitionsBackToOpen(t *testing.T) {
	cfg := DefaultConfig()
	cfg.FailureThreshold = 1
	cfg.Timeout = 10 * time.Millisecond
	cfg.HalfOpenMaxCalls = 3
	cfg.SuccessThreshold = 3
	cfg.SlidingWindowSize = 5

	cb := New("svc", cfg)
	cb.clearSlidingWindow()

	_ = cb.Execute(context.Background(), func() error { return errors.New("fail") })
	assert.Equal(t, StateOpen, cb.State())

	time.Sleep(cfg.Timeout + 10*time.Millisecond)

	// first allowed -> half-open
	assert.NoError(t, cb.Execute(context.Background(), func() error { return nil }))
	assert.Equal(t, StateHalfOpen, cb.State())

	// failure in half-open should open immediately
	_ = cb.Execute(context.Background(), func() error { return errors.New("fail2") })
	assert.Equal(t, StateOpen, cb.State())
}

func TestCircuitBreaker_ExecuteWithFallback(t *testing.T) {
	cfg := DefaultConfig()
	cfg.SlidingWindowSize = 5
	cb := New("svc", cfg)

	opErr := errors.New("op")
	fbErr := errors.New("fb")

	t.Run("no error no fallback called", func(t *testing.T) {
		called := int32(0)
		err := cb.ExecuteWithFallback(context.Background(),
			func() error { return nil },
			func() error {
				atomic.AddInt32(&called, 1)
				return nil
			},
		)
		assert.NoError(t, err)
		assert.Equal(t, int32(0), atomic.LoadInt32(&called))
	})

	t.Run("error and fallback called", func(t *testing.T) {
		called := int32(0)
		err := cb.ExecuteWithFallback(context.Background(),
			func() error { return opErr },
			func() error {
				atomic.AddInt32(&called, 1)
				return nil
			},
		)
		assert.NoError(t, err)
		assert.Equal(t, int32(1), atomic.LoadInt32(&called))
	})

	t.Run("error and fallback returns error", func(t *testing.T) {
		err := cb.ExecuteWithFallback(context.Background(),
			func() error { return opErr },
			func() error { return fbErr },
		)
		assert.ErrorIs(t, err, fbErr)
	})

	t.Run("error and nil fallback returns original error", func(t *testing.T) {
		err := cb.ExecuteWithFallback(context.Background(),
			func() error { return opErr },
			nil,
		)
		assert.ErrorIs(t, err, opErr)
	})
}

func TestCircuitBreaker_OnStateChangeCallback(t *testing.T) {
	cfg := DefaultConfig()
	cfg.FailureThreshold = 1
	cfg.SlidingWindowSize = 5
	cb := New("svc", cfg)
	cb.clearSlidingWindow()

	var (
		mu    sync.Mutex
		calls []struct {
			name string
			from State
			to   State
		}
	)
	cb.onStateChange = func(name string, from, to State) {
		mu.Lock()
		defer mu.Unlock()
		calls = append(calls, struct {
			name string
			from State
			to   State
		}{name: name, from: from, to: to})
	}

	_ = cb.Execute(context.Background(), func() error { return errors.New("fail") })
	assert.Equal(t, StateOpen, cb.State())

	mu.Lock()
	defer mu.Unlock()
	assert.NotEmpty(t, calls)
	assert.Equal(t, "svc", calls[0].name)
	assert.Equal(t, StateClosed, calls[0].from)
	assert.Equal(t, StateOpen, calls[0].to)
}

func TestCircuitBreaker_GetHealthInfo(t *testing.T) {
	cfg := DefaultConfig()
	cfg.SlidingWindowSize = 4
	cb := New("svc", cfg)
	cb.clearSlidingWindow()

	_ = cb.Execute(context.Background(), func() error { return nil })
	_ = cb.Execute(context.Background(), func() error { return errors.New("fail") })

	hi := cb.GetHealthInfo()
	assert.Equal(t, "svc", hi.Name)
	assert.Contains(t, []string{"CLOSED", "OPEN", "HALF_OPEN"}, hi.State)
	assert.GreaterOrEqual(t, hi.FailureRate, 0.0)
	assert.LessOrEqual(t, hi.FailureRate, 1.0)

	assert.Contains(t, hi.Metrics, "total_calls")
	assert.Contains(t, hi.Metrics, "successful_calls")
	assert.Contains(t, hi.Metrics, "failed_calls")
	assert.Contains(t, hi.Metrics, "rejected_calls")
	assert.Contains(t, hi.Metrics, "state_changes")
	assert.Contains(t, hi.Metrics, "avg_response_time_ms")

	assert.Equal(t, uint64(2), hi.Metrics["total_calls"].(uint64))
	assert.Equal(t, uint64(1), hi.Metrics["successful_calls"].(uint64))
	assert.Equal(t, uint64(1), hi.Metrics["failed_calls"].(uint64))
}

func TestDistributedCoordinator_New_NodeIDFromEnvOrPid(t *testing.T) {
	old := os.Getenv("NODE_ID")
	t.Cleanup(func() {
		_ = os.Setenv("NODE_ID", old)
	})

	_ = os.Setenv("NODE_ID", "node-xyz")
	dc := NewDistributedCoordinator("http://example.com")
	assert.Equal(t, "node-xyz", dc.nodeID)

	_ = os.Unsetenv("NODE_ID")
	dc2 := NewDistributedCoordinator("http://example.com")
	assert.NotEmpty(t, dc2.nodeID)
	assert.Contains(t, dc2.nodeID, "go-")
}

func TestDistributedCoordinator_Register_AndSyncStates_Reports(t *testing.T) {
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
	cfg.SlidingWindowSize = 5
	cb1 := New("svc1", cfg)
	cb2 := New("svc2", cfg)

	dc.Register(cb1)
	dc.Register(cb2)

	dc.syncStates()

	assert.Equal(t, int32(2), atomic.LoadInt32(&hits))
}

func TestDistributedCoordinator_StartSync_Stop(t *testing.T) {
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
	dc.syncInterval = 10 * time.Millisecond

	cfg := DefaultConfig()
	cfg.SlidingWindowSize = 5
	cb := New("svc", cfg)
	dc.Register(cb)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan struct{})
	go func() {
		dc.StartSync(ctx)
		close(done)
	}()

	time.Sleep(35 * time.Millisecond)
	dc.Stop()

	select {
	case <-done:
	case <-time.After(250 * time.Millisecond):
		t.Fatalf("StartSync did not stop in time")
	}

	assert.GreaterOrEqual(t, atomic.LoadInt32(&hits), int32(1))
}
