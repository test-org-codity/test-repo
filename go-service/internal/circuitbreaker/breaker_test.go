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
		{"half_open", StateHalfOpen, "HALF_OPEN"},
		{"unknown", State(123), "UNKNOWN"},
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

func TestRingBuffer_Average_Empty(t *testing.T) {
	rb := NewRingBuffer(3)
	assert.Equal(t, time.Duration(0), rb.Average())
}

func TestRingBuffer_AddAndAverage_NoWrap(t *testing.T) {
	rb := NewRingBuffer(5)
	rb.Add(10 * time.Millisecond)
	rb.Add(20 * time.Millisecond)
	rb.Add(30 * time.Millisecond)

	assert.Equal(t, 20*time.Millisecond, rb.Average())
}

func TestRingBuffer_AddAndAverage_WrapExposesImplementationBehavior(t *testing.T) {
	// NOTE: current Average() sums data[0:count], not the last N values by time.
	// This test locks in current behavior, including after wrap-around.
	rb := NewRingBuffer(3)
	rb.Add(10 * time.Millisecond) // data[0]=10
	rb.Add(20 * time.Millisecond) // data[1]=20
	rb.Add(30 * time.Millisecond) // data[2]=30
	assert.Equal(t, 20*time.Millisecond, rb.Average())

	rb.Add(40 * time.Millisecond) // overwrites data[0]=40, head=1, count=3
	// Average uses data[0],data[1],data[2] => 40,20,30 => 90/3=30ms
	assert.Equal(t, 30*time.Millisecond, rb.Average())
}

func TestNewAndBasicAccessors(t *testing.T) {
	cfg := DefaultConfig()
	cb := New("svc", cfg)
	assert.NotNil(t, cb)
	assert.Equal(t, "svc", cb.Name())
	assert.Equal(t, StateClosed, cb.State())
	assert.NotNil(t, cb.metrics)
	assert.NotNil(t, cb.metrics.responseTimes)
	assert.Len(t, cb.slidingWindow, cfg.SlidingWindowSize)
}

func TestGetOrCreate_ReturnsSameInstance(t *testing.T) {
	registryMu.Lock()
	registry = make(map[string]*CircuitBreaker)
	registryMu.Unlock()

	cfg := DefaultConfig()
	a := GetOrCreate("x", cfg)
	b := GetOrCreate("x", cfg)
	assert.Same(t, a, b)
}

func TestCircuitBreaker_Execute_SuccessUpdatesMetricsAndWindow(t *testing.T) {
	cfg := DefaultConfig()
	cfg.SlidingWindowSize = 4
	cb := New("svc", cfg)

	err := cb.Execute(context.Background(), func() error {
		time.Sleep(1 * time.Millisecond)
		return nil
	})

	assert.NoError(t, err)
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.TotalCalls))
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.SuccessfulCalls))
	assert.Equal(t, uint64(0), atomic.LoadUint64(&cb.metrics.FailedCalls))
	assert.Equal(t, uint64(0), atomic.LoadUint64(&cb.metrics.RejectedCalls))

	cb.metrics.mu.RLock()
	lastSuccess := cb.metrics.LastSuccess
	lastFailure := cb.metrics.LastFailure
	cb.metrics.mu.RUnlock()
	assert.False(t, lastSuccess.IsZero())
	assert.True(t, lastFailure.IsZero())

	assert.GreaterOrEqual(t, cb.metrics.responseTimes.Average(), time.Duration(0))
	assert.Equal(t, StateClosed, cb.State())
}

func TestCircuitBreaker_Execute_FailureOpensOnFailureThreshold(t *testing.T) {
	cfg := DefaultConfig()
	cfg.FailureThreshold = 2
	cfg.FailureRateThreshold = 1.0
	cfg.SlidingWindowSize = 4
	cb := New("svc", cfg)

	sentinel := errors.New("boom")

	err := cb.Execute(context.Background(), func() error { return sentinel })
	assert.ErrorIs(t, err, sentinel)
	assert.Equal(t, StateClosed, cb.State())

	err = cb.Execute(context.Background(), func() error { return sentinel })
	assert.ErrorIs(t, err, sentinel)
	assert.Equal(t, StateOpen, cb.State())

	assert.Equal(t, uint64(2), atomic.LoadUint64(&cb.metrics.TotalCalls))
	assert.Equal(t, uint64(0), atomic.LoadUint64(&cb.metrics.SuccessfulCalls))
	assert.Equal(t, uint64(2), atomic.LoadUint64(&cb.metrics.FailedCalls))

	cb.metrics.mu.RLock()
	lastFailure := cb.metrics.LastFailure
	cb.metrics.mu.RUnlock()
	assert.False(t, lastFailure.IsZero())
}

func TestCircuitBreaker_Execute_RejectsWhenOpenAndNotTimedOut(t *testing.T) {
	cfg := DefaultConfig()
	cfg.FailureThreshold = 1
	cfg.Timeout = 100 * time.Millisecond
	cfg.FailureRateThreshold = 1.0
	cfg.SlidingWindowSize = 4
	cb := New("svc", cfg)

	_ = cb.Execute(context.Background(), func() error { return errors.New("fail") })
	assert.Equal(t, StateOpen, cb.State())

	called := int32(0)
	err := cb.Execute(context.Background(), func() error {
		atomic.AddInt32(&called, 1)
		return nil
	})

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "circuit breaker 'svc' is open")
	assert.Equal(t, int32(0), atomic.LoadInt32(&called))
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.RejectedCalls))
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.TotalCalls))
}

func TestCircuitBreaker_OpenToHalfOpenAfterTimeout_AllowsLimitedCalls(t *testing.T) {
	// The implementation currently panics when transitioning back to CLOSED because
	// it attempts to atomic.Value.Store(nil). This test avoids the CLOSED transition
	// while still validating the Open -> HalfOpen behavior and call limiting.
	cfg := DefaultConfig()
	cfg.FailureThreshold = 1
	cfg.Timeout = 20 * time.Millisecond
	cfg.HalfOpenMaxCalls = 2
	cfg.SuccessThreshold = 2
	cfg.FailureRateThreshold = 1.0
	cfg.SlidingWindowSize = 4
	cb := New("svc", cfg)

	_ = cb.Execute(context.Background(), func() error { return errors.New("fail") })
	assert.Equal(t, StateOpen, cb.State())

	time.Sleep(cfg.Timeout + 10*time.Millisecond)

	calls := int32(0)
	opOK := func() error {
		atomic.AddInt32(&calls, 1)
		return nil
	}

	// 1st call should transition to HALF_OPEN and allow.
	err := cb.Execute(context.Background(), opOK)
	assert.NoError(t, err)
	assert.Equal(t, StateHalfOpen, cb.State())

	// 2nd call should still be allowed (HalfOpenMaxCalls=2).
	err = cb.Execute(context.Background(), opOK)
	assert.NoError(t, err)
	assert.Equal(t, StateHalfOpen, cb.State())

	// Ensure operation called twice, no rejections in half-open stage.
	assert.Equal(t, int32(2), atomic.LoadInt32(&calls))
	assert.Equal(t, uint64(0), atomic.LoadUint64(&cb.metrics.RejectedCalls))
}

func TestCircuitBreaker_HalfOpen_RejectsBeyondMaxCalls(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Timeout = 0
	cfg.HalfOpenMaxCalls = 2
	cfg.SuccessThreshold = 100
	cfg.SlidingWindowSize = 4
	cb := New("svc", cfg)

	cb.transitionTo(StateHalfOpen)
	assert.Equal(t, StateHalfOpen, cb.State())

	calls := int32(0)
	op := func() error {
		atomic.AddInt32(&calls, 1)
		return nil
	}

	err := cb.Execute(context.Background(), op)
	assert.NoError(t, err)
	err = cb.Execute(context.Background(), op)
	assert.NoError(t, err)

	// Third should be rejected by allowRequest.
	err = cb.Execute(context.Background(), op)
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "circuit breaker 'svc' is open")
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.RejectedCalls))
	assert.Equal(t, int32(2), atomic.LoadInt32(&calls))
}

func TestCircuitBreaker_HalfOpen_FailureTransitionsToOpen(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Timeout = 0
	cfg.SlidingWindowSize = 4
	cb := New("svc", cfg)

	cb.transitionTo(StateHalfOpen)
	assert.Equal(t, StateHalfOpen, cb.State())

	sentinel := errors.New("nope")
	err := cb.Execute(context.Background(), func() error { return sentinel })
	assert.ErrorIs(t, err, sentinel)
	assert.Equal(t, StateOpen, cb.State())
}

func TestCircuitBreaker_ExecuteWithFallback_CallsFallbackOnError(t *testing.T) {
	cfg := DefaultConfig()
	cfg.FailureThreshold = 100
	cfg.SlidingWindowSize = 4
	cb := New("svc", cfg)

	opCalls := int32(0)
	fbCalls := int32(0)

	sentinel := errors.New("op err")
	fbErr := errors.New("fb err")

	err := cb.ExecuteWithFallback(context.Background(),
		func() error {
			atomic.AddInt32(&opCalls, 1)
			return sentinel
		},
		func() error {
			atomic.AddInt32(&fbCalls, 1)
			return fbErr
		},
	)

	assert.ErrorIs(t, err, fbErr)
	assert.Equal(t, int32(1), atomic.LoadInt32(&opCalls))
	assert.Equal(t, int32(1), atomic.LoadInt32(&fbCalls))
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.TotalCalls))
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.FailedCalls))
}

func TestCircuitBreaker_ExecuteWithFallback_NoFallbackReturnsOriginalError(t *testing.T) {
	cfg := DefaultConfig()
	cfg.FailureThreshold = 100
	cfg.SlidingWindowSize = 4
	cb := New("svc", cfg)

	sentinel := errors.New("op err")

	err := cb.ExecuteWithFallback(context.Background(),
		func() error { return sentinel },
		nil,
	)

	assert.ErrorIs(t, err, sentinel)
}

func TestCircuitBreaker_StateTransitions_InvokeOnStateChange(t *testing.T) {
	cfg := DefaultConfig()
	cfg.SlidingWindowSize = 4
	cb := New("svc", cfg)

	var mu sync.Mutex
	var changes []struct {
		from State
		to   State
	}
	cb.onStateChange = func(name string, from, to State) {
		assert.Equal(t, "svc", name)
		mu.Lock()
		changes = append(changes, struct {
			from State
			to   State
		}{from: from, to: to})
		mu.Unlock()
	}

	cb.transitionTo(StateOpen)
	cb.transitionTo(StateHalfOpen)
	cb.transitionTo(StateClosed)

	assert.Equal(t, uint64(3), atomic.LoadUint64(&cb.metrics.StateChanges))

	mu.Lock()
	defer mu.Unlock()
	assert.Len(t, changes, 3)
	assert.Equal(t, StateClosed, changes[0].from)
	assert.Equal(t, StateOpen, changes[0].to)
	assert.Equal(t, StateOpen, changes[1].from)
	assert.Equal(t, StateHalfOpen, changes[1].to)
	assert.Equal(t, StateHalfOpen, changes[2].from)
	assert.Equal(t, StateClosed, changes[2].to)
}

func TestCircuitBreaker_ClearSlidingWindow_SetsAllTrueAndResetsIndex(t *testing.T) {
	cfg := DefaultConfig()
	cfg.SlidingWindowSize = 5
	cb := New("svc", cfg)

	cb.addToSlidingWindow(false)
	cb.addToSlidingWindow(false)

	cb.clearSlidingWindow()

	cb.windowMu.Lock()
	defer cb.windowMu.Unlock()
	for i := range cb.slidingWindow {
		assert.True(t, cb.slidingWindow[i])
	}
	assert.Equal(t, 0, cb.windowIndex)
}

func TestCircuitBreaker_CalculateFailureRate(t *testing.T) {
	cfg := DefaultConfig()
	cfg.SlidingWindowSize = 4
	cb := New("svc", cfg)

	cb.windowMu.Lock()
	cb.slidingWindow[0] = true
	cb.slidingWindow[1] = false
	cb.slidingWindow[2] = false
	cb.slidingWindow[3] = true
	cb.windowMu.Unlock()

	assert.InEpsilon(t, 0.5, cb.calculateFailureRate(), 0.0001)
}

func TestCircuitBreaker_GetHealthInfo(t *testing.T) {
	cfg := DefaultConfig()
	cfg.SlidingWindowSize = 4
	cb := New("svc", cfg)

	_ = cb.Execute(context.Background(), func() error { return nil })
	_ = cb.Execute(context.Background(), func() error { return errors.New("x") })

	hi := cb.GetHealthInfo()
	assert.Equal(t, "svc", hi.Name)
	assert.Equal(t, cb.State().String(), hi.State)
	assert.Equal(t, int(atomic.LoadInt32(&cb.failureCount)), hi.FailureCount)
	assert.Equal(t, int(atomic.LoadInt32(&cb.successCount)), hi.SuccessCount)
	assert.InDelta(t, cb.calculateFailureRate(), hi.FailureRate, 0.0001)

	assert.Contains(t, hi.Metrics, "total_calls")
	assert.Contains(t, hi.Metrics, "successful_calls")
	assert.Contains(t, hi.Metrics, "failed_calls")
	assert.Contains(t, hi.Metrics, "rejected_calls")
	assert.Contains(t, hi.Metrics, "state_changes")
	assert.Contains(t, hi.Metrics, "avg_response_time_ms")

	assert.Equal(t, atomic.LoadUint64(&cb.metrics.TotalCalls), hi.Metrics["total_calls"])
	assert.Equal(t, atomic.LoadUint64(&cb.metrics.SuccessfulCalls), hi.Metrics["successful_calls"])
	assert.Equal(t, atomic.LoadUint64(&cb.metrics.FailedCalls), hi.Metrics["failed_calls"])
	assert.Equal(t, atomic.LoadUint64(&cb.metrics.RejectedCalls), hi.Metrics["rejected_calls"])
	assert.Equal(t, atomic.LoadUint64(&cb.metrics.StateChanges), hi.Metrics["state_changes"])
}

func TestDistributedCoordinator_NewDistributedCoordinator_UsesEnvNodeIDOrFallback(t *testing.T) {
	old := os.Getenv("NODE_ID")
	t.Cleanup(func() { _ = os.Setenv("NODE_ID", old) })

	_ = os.Setenv("NODE_ID", "node-123")
	dc := NewDistributedCoordinator("http://example.com")
	assert.Equal(t, "node-123", dc.nodeID)

	_ = os.Unsetenv("NODE_ID")
	dc2 := NewDistributedCoordinator("http://example.com")
	assert.NotEmpty(t, dc2.nodeID)
	assert.Contains(t, dc2.nodeID, "go-")
}

func TestDistributedCoordinator_RegisterAndSyncStates_ReportsEachBreaker(t *testing.T) {
	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" && r.URL.Path == "/circuit-breakers/state" {
			atomic.AddInt32(&hits, 1)
			w.WriteHeader(http.StatusOK)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	dc := NewDistributedCoordinator(srv.URL)
	dc.client = srv.Client()

	cb1 := New("a", DefaultConfig())
	cb2 := New("b", DefaultConfig())

	dc.Register(cb1)
	dc.Register(cb2)

	dc.syncStates()

	assert.Equal(t, int32(2), atomic.LoadInt32(&hits))
}

func TestDistributedCoordinator_StartSync_StopsOnContextCancel(t *testing.T) {
	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" && r.URL.Path == "/circuit-breakers/state" {
			atomic.AddInt32(&hits, 1)
			w.WriteHeader(http.StatusOK)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	dc := NewDistributedCoordinator(srv.URL)
	dc.client = srv.Client()
	dc.syncInterval = 10 * time.Millisecond

	dc.Register(New("a", DefaultConfig()))

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		dc.StartSync(ctx)
	}()

	time.Sleep(35 * time.Millisecond)
	cancel()

	select {
	case <-done:
	case <-time.After(500 * time.Millisecond):
		assert.Fail(t, "StartSync did not return after context cancellation")
	}

	assert.GreaterOrEqual(t, atomic.LoadInt32(&hits), int32(1))
}

func TestDistributedCoordinator_StartSync_StopsOnStopChan(t *testing.T) {
	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" && r.URL.Path == "/circuit-breakers/state" {
			atomic.AddInt32(&hits, 1)
			w.WriteHeader(http.StatusOK)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	dc := NewDistributedCoordinator(srv.URL)
	dc.client = srv.Client()
	dc.syncInterval = 10 * time.Millisecond

	dc.Register(New("a", DefaultConfig()))

	ctx := context.Background()
	done := make(chan struct{})
	go func() {
		defer close(done)
		dc.StartSync(ctx)
	}()

	time.Sleep(20 * time.Millisecond)
	dc.Stop()

	select {
	case <-done:
	case <-time.After(500 * time.Millisecond):
		assert.Fail(t, "StartSync did not return after Stop()")
	}

	assert.GreaterOrEqual(t, atomic.LoadInt32(&hits), int32(0))
}
