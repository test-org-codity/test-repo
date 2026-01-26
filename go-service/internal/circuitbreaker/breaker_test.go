package circuitbreaker

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

func TestState_String(t *testing.T) {
	assert.Equal(t, "CLOSED", StateClosed.String())
	assert.Equal(t, "OPEN", StateOpen.String())
	assert.Equal(t, "HALF_OPEN", StateHalfOpen.String())
	var s State = 999
	assert.Equal(t, "UNKNOWN", s.String())
}

func TestRingBuffer_AddAverage(t *testing.T) {
	rb := NewRingBuffer(3)

	// Average of empty buffer
	assert.Equal(t, time.Duration(0), rb.Average())

	// Add less than size
	rb.Add(10 * time.Millisecond)
	rb.Add(20 * time.Millisecond)
	assert.InDelta(t, (15 * time.Millisecond).Milliseconds(), rb.Average().Milliseconds(), 1)

	// Fill to size
	rb.Add(30 * time.Millisecond)
	assert.InDelta(t, (20 * time.Millisecond).Milliseconds(), rb.Average().Milliseconds(), 1)

	// Wrap around
	rb.Add(40 * time.Millisecond) // overwrites first (10ms)
	// Now buffer contains: 40ms, 20ms, 30ms => avg = 30ms
	assert.InDelta(t, (30 * time.Millisecond).Milliseconds(), rb.Average().Milliseconds(), 1)
}

func TestCircuitBreaker_NewInitialState(t *testing.T) {
	cfg := DefaultConfig()
	cb := New("svc-initial", cfg)
	assert.Equal(t, "svc-initial", cb.Name())
	assert.Equal(t, StateClosed, cb.State())
	assert.Equal(t, cfg.SlidingWindowSize, len(cb.slidingWindow))
}

func TestGetOrCreate_ReturnsSameInstance(t *testing.T) {
	cfg := DefaultConfig()
	name := "unique-breaker"
	cb1 := GetOrCreate(name, cfg)
	cb2 := GetOrCreate(name, cfg)
	assert.Same(t, cb1, cb2)
}

func TestExecute_SuccessClosed(t *testing.T) {
	cfg := DefaultConfig()
	cfg.FailureRateThreshold = 1.0 // avoid opening due to initial sliding window values
	cb := New("svc-success", cfg)
	cb.clearSlidingWindow()

	err := cb.Execute(context.Background(), func() error {
		time.Sleep(5 * time.Millisecond)
		return nil
	})
	assert.NoError(t, err)
	assert.Equal(t, StateClosed, cb.State())
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.TotalCalls))
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.SuccessfulCalls))
	assert.Equal(t, uint64(0), atomic.LoadUint64(&cb.metrics.FailedCalls))
}

func TestExecute_FailureThresholdOpens(t *testing.T) {
	cfg := DefaultConfig()
	cfg.FailureThreshold = 2
	cfg.FailureRateThreshold = 1.0 // ensure threshold drives opening
	cb := New("svc-fail-threshold", cfg)
	cb.clearSlidingWindow()

	opErr := errors.New("fail")
	err := cb.Execute(context.Background(), func() error { return opErr })
	assert.Equal(t, opErr, err)
	assert.Equal(t, StateClosed, cb.State())

	err = cb.Execute(context.Background(), func() error { return opErr })
	assert.Equal(t, opErr, err)
	assert.Equal(t, StateOpen, cb.State())
	assert.Equal(t, uint64(2), atomic.LoadUint64(&cb.metrics.FailedCalls))
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.StateChanges))

	// openedAt should be set
	assert.NotNil(t, cb.openedAt.Load())
}

func TestExecute_FailureRateOpens(t *testing.T) {
	cfg := DefaultConfig()
	cfg.SlidingWindowSize = 4
	cfg.FailureRateThreshold = 0.5
	cfg.FailureThreshold = 1000 // avoid threshold opening
	cb := New("svc-fail-rate", cfg)
	cb.clearSlidingWindow()

	// Fill with successes
	for i := 0; i < cfg.SlidingWindowSize; i++ {
		_ = cb.Execute(context.Background(), func() error { return nil })
	}

	// Now two failures should bring failure rate to 0.5 and open
	_ = cb.Execute(context.Background(), func() error { return errors.New("fail1") })
	assert.Equal(t, StateClosed, cb.State())

	_ = cb.Execute(context.Background(), func() error { return errors.New("fail2") })
	assert.Equal(t, StateOpen, cb.State())
}

func TestExecute_OpenRejectsAndCounts(t *testing.T) {
	cfg := DefaultConfig()
	cb := New("svc-open-reject", cfg)
	cb.transitionTo(StateOpen)

	called := int32(0)
	err := cb.Execute(context.Background(), func() error {
		atomic.AddInt32(&called, 1)
		return nil
	})

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "is open")
	assert.Equal(t, int32(0), atomic.LoadInt32(&called))
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.RejectedCalls))
	// TotalCalls should not increment on rejection
	assert.Equal(t, uint64(0), atomic.LoadUint64(&cb.metrics.TotalCalls))
}

func TestAllowRequest_OpenAfterTimeoutTransitionsToHalfOpen(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Timeout = 1 * time.Millisecond
	cb := New("svc-half-open-reset", cfg)
	cb.transitionTo(StateOpen)

	// Set openedAt to past to trigger reset
	cb.openedAt.Store(time.Now().Add(-5 * time.Millisecond))

	allowed := cb.allowRequest()
	assert.True(t, allowed)
	assert.Equal(t, StateHalfOpen, cb.State())
}

func TestHalfOpen_AllowsLimitedCalls(t *testing.T) {
	cfg := DefaultConfig()
	cfg.HalfOpenMaxCalls = 2
	cb := New("svc-half-open-calls", cfg)
	cb.transitionTo(StateHalfOpen)

	// First two allowed
	assert.True(t, cb.allowRequest())
	assert.True(t, cb.allowRequest())
	// Third should be rejected
	assert.False(t, cb.allowRequest())
}

func TestHalfOpen_SuccessThresholdCloses(t *testing.T) {
	cfg := DefaultConfig()
	cfg.SuccessThreshold = 2
	cfg.HalfOpenMaxCalls = 5
	cb := New("svc-half-open-success", cfg)
	cb.transitionTo(StateHalfOpen)

	// Two successful probes
	err := cb.Execute(context.Background(), func() error { return nil })
	assert.NoError(t, err)
	err = cb.Execute(context.Background(), func() error { return nil })
	assert.NoError(t, err)

	assert.Equal(t, StateClosed, cb.State())
	// successCount reset to 0 on close
	assert.Equal(t, int32(0), atomic.LoadInt32(&cb.successCount))
}

func TestHalfOpen_FailureTransitionsToOpen(t *testing.T) {
	cfg := DefaultConfig()
	cfg.HalfOpenMaxCalls = 5
	cb := New("svc-half-open-fail", cfg)
	cb.transitionTo(StateHalfOpen)

	err := cb.Execute(context.Background(), func() error { return errors.New("probe fail") })
	assert.Error(t, err)
	assert.Equal(t, StateOpen, cb.State())
}

func TestRecordSuccess_DecrementsFailureCountInClosed(t *testing.T) {
	cfg := DefaultConfig()
	cb := New("svc-decrement-failures", cfg)
	cb.transitionTo(StateClosed)

	atomic.StoreInt32(&cb.failureCount, 3)
	cb.recordSuccess(1 * time.Millisecond)
	assert.Equal(t, int32(2), atomic.LoadInt32(&cb.failureCount))

	cb.recordSuccess(1 * time.Millisecond)
	cb.recordSuccess(1 * time.Millisecond)
	cb.recordSuccess(1 * time.Millisecond) // should not go below 0
	assert.Equal(t, int32(0), atomic.LoadInt32(&cb.failureCount))
}

func TestGetHealthInfo(t *testing.T) {
	cfg := DefaultConfig()
	cfg.FailureRateThreshold = 1.0 // avoid opening due to rate
	cb := New("svc-health", cfg)
	cb.clearSlidingWindow()

	// One success and one failure via Execute to increment TotalCalls as well
	_ = cb.Execute(context.Background(), func() error {
		time.Sleep(10 * time.Millisecond)
		return nil
	})
	_ = cb.Execute(context.Background(), func() error {
		time.Sleep(20 * time.Millisecond)
		return errors.New("boom")
	})

	info := cb.GetHealthInfo()
	assert.Equal(t, "svc-health", info.Name)
	assert.Equal(t, StateClosed.String(), info.State) // should remain closed
	// failure_count is the internal counter; after one failure and a success it may be 0
	assert.GreaterOrEqual(t, info.FailureCount, 0)
	assert.GreaterOrEqual(t, info.SuccessCount, 0)
	assert.Contains(t, info.Metrics, "total_calls")
	assert.EqualValues(t, 2, info.Metrics["total_calls"])
	assert.EqualValues(t, 1, info.Metrics["successful_calls"])
	assert.EqualValues(t, 1, info.Metrics["failed_calls"])
	assert.EqualValues(t, 0, info.Metrics["rejected_calls"])
	assert.Contains(t, info.Metrics, "avg_response_time_ms")
	// average should be positive
	avg := info.Metrics["avg_response_time_ms"].(int64)
	assert.Greater(t, avg, int64(0))
}

func TestCalculateFailureRateAndClearSlidingWindow(t *testing.T) {
	cfg := DefaultConfig()
	cfg.SlidingWindowSize = 4
	cb := New("svc-failure-rate", cfg)

	// Start with cleared window (all true)
	cb.clearSlidingWindow()
	assert.Equal(t, 0.0, cb.calculateFailureRate())

	// Add one failure; expect 1/4 = 0.25
	cb.addToSlidingWindow(false)
	assert.InDelta(t, 0.25, cb.calculateFailureRate(), 0.0001)

	// Add another failure; expect 2/4 = 0.5
	cb.addToSlidingWindow(false)
	assert.InDelta(t, 0.5, cb.calculateFailureRate(), 0.0001)
}

func TestExecuteWithFallback_PrimaryFailsFallbackSucceeds(t *testing.T) {
	cfg := DefaultConfig()
	cfg.FailureRateThreshold = 1.0 // avoid rate-open
	cb := New("svc-fallback", cfg)
	cb.clearSlidingWindow()

	called := struct {
		primary  int32
		fallback int32
	}{}

	err := cb.ExecuteWithFallback(context.Background(),
		func() error {
			atomic.AddInt32(&called.primary, 1)
			return errors.New("primary fail")
		},
		func() error {
			atomic.AddInt32(&called.fallback, 1)
			return nil
		},
	)

	assert.NoError(t, err)
	assert.Equal(t, int32(1), atomic.LoadInt32(&called.primary))
	assert.Equal(t, int32(1), atomic.LoadInt32(&called.fallback))
}

func TestDistributedCoordinator_RegisterAndReportState(t *testing.T) {
	var hits int32
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/circuit-breakers/state" && r.Method == http.MethodPost {
			atomic.AddInt32(&hits, 1)
			w.WriteHeader(http.StatusOK)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer ts.Close()

	dc := NewDistributedCoordinator(ts.URL)
	dc.client = ts.Client()

	cb := New("svc-report", DefaultConfig())
	dc.Register(cb)

	// Directly invoke syncStates to avoid ticker timing
	dc.syncStates()

	assert.Equal(t, int32(1), atomic.LoadInt32(&hits))
}

func TestDistributedCoordinator_StartSyncAndStop(t *testing.T) {
	var hits int32
	var mu sync.Mutex
	seen := make(chan struct{}, 1)

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/circuit-breakers/state" && r.Method == http.MethodPost {
			mu.Lock()
			if atomic.AddInt32(&hits, 1) == 1 {
				select {
				case seen <- struct{}{}:
				default:
				}
			}
			mu.Unlock()
			w.WriteHeader(http.StatusOK)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer ts.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	dc := NewDistributedCoordinator(ts.URL)
	dc.client = ts.Client()
	dc.syncInterval = 20 * time.Millisecond

	cb := New("svc-sync", DefaultConfig())
	dc.Register(cb)

	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		dc.StartSync(ctx)
	}()

	// Wait for at least one sync tick
	select {
	case <-seen:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("did not receive sync request in time")
	}

	// Stop and cancel
	dc.Stop()
	cancel()

	// Wait for goroutine to exit
	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(1 * time.Second):
		t.Fatal("StartSync did not stop in time")
	}

	assert.GreaterOrEqual(t, atomic.LoadInt32(&hits), int32(1))
}
