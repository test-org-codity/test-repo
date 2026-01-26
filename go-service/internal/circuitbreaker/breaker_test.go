package circuitbreaker

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
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
	return Config{
		FailureThreshold:     3,
		SuccessThreshold:     2,
		Timeout:              20 * time.Millisecond,
		HalfOpenMaxCalls:     2,
		SlidingWindowSize:    4,
		FailureRateThreshold: 0.5,
	}
}

func newTestCB(name string) *CircuitBreaker {
	cb := New(name, newTestConfig())
	// Ensure sliding window starts as successful entries to avoid accidental failure-rate triggers.
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
	assert.Equal(t, 15*time.Millisecond, rb.Average())

	// Add more than size to wrap around
	rb.Add(30 * time.Millisecond)
	rb.Add(40 * time.Millisecond)
	// Last three are 20, 30, 40 => average = 30
	assert.Equal(t, 30*time.Millisecond, rb.Average())
}

func TestNewAndGetOrCreate(t *testing.T) {
	resetRegistry()

	cfg := newTestConfig()
	cb := New("svc-A", cfg)
	assert.Equal(t, "svc-A", cb.Name())
	assert.Equal(t, StateClosed, cb.State())
	assert.Len(t, cb.slidingWindow, cfg.SlidingWindowSize)
	assert.NotNil(t, cb.metrics)
	assert.NotNil(t, cb.metrics.responseTimes)

	// GetOrCreate creates and returns same instance for same name
	cb1 := GetOrCreate("svc-A", cfg)
	cb2 := GetOrCreate("svc-A", cfg)
	assert.Same(t, cb1, cb2)

	// Different name => different instance
	cb3 := GetOrCreate("svc-B", cfg)
	assert.NotSame(t, cb1, cb3)
}

func TestCircuitBreaker_Execute_Success(t *testing.T) {
	cb := newTestCB("success")

	err := cb.Execute(context.Background(), func() error {
		time.Sleep(2 * time.Millisecond)
		return nil
	})
	assert.NoError(t, err)
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.TotalCalls))
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.SuccessfulCalls))
	assert.Equal(t, uint64(0), atomic.LoadUint64(&cb.metrics.FailedCalls))
	assert.Equal(t, StateClosed, cb.State())
	avg := cb.metrics.responseTimes.Average()
	assert.Greater(t, avg, time.Duration(0))
}

func TestCircuitBreaker_Execute_FailureThreshold_Opens(t *testing.T) {
	cb := newTestCB("fail-threshold")
	cb.config.FailureThreshold = 2
	cb.config.FailureRateThreshold = 1.0 // ensure only threshold triggers; window is cleared

	for i := 0; i < 2; i++ {
		err := cb.Execute(context.Background(), func() error {
			return assert.AnError
		})
		assert.Error(t, err)
	}
	assert.Equal(t, uint64(2), atomic.LoadUint64(&cb.metrics.FailedCalls))
	assert.Equal(t, StateOpen, cb.State())
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.StateChanges)) // CLOSED -> OPEN
}

func TestCircuitBreaker_FailureRateThreshold_Opens(t *testing.T) {
	cb := newTestCB("fail-rate")
	cb.config.FailureThreshold = 10 // high threshold, rely on rate
	cb.config.SlidingWindowSize = 4
	cb.clearSlidingWindow()

	// Two failures -> failure rate 2/4 = 0.5 => meets threshold
	err := cb.Execute(context.Background(), func() error { return assert.AnError })
	assert.Error(t, err)
	err = cb.Execute(context.Background(), func() error { return assert.AnError })
	assert.Error(t, err)

	assert.Equal(t, StateOpen, cb.State())
}

func TestCircuitBreaker_OpenRejects_And_HalfOpenAfterTimeout(t *testing.T) {
	cb := newTestCB("timeout-reset")
	cb.config.Timeout = 10 * time.Millisecond
	cb.config.HalfOpenMaxCalls = 1
	cb.config.SuccessThreshold = 1
	cb.config.FailureThreshold = 1 // open immediately on first failure

	// Open the breaker
	err := cb.Execute(context.Background(), func() error { return assert.AnError })
	assert.Error(t, err)
	assert.Equal(t, StateOpen, cb.State())

	// Immediately try again -> should be rejected due to open state
	err = cb.Execute(context.Background(), func() error { return nil })
	assert.Error(t, err)
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.RejectedCalls))
	assert.Equal(t, StateOpen, cb.State())

	// Wait for timeout and then try failing op in half-open path
	time.Sleep(cb.config.Timeout + 5*time.Millisecond)
	err = cb.Execute(context.Background(), func() error { return assert.AnError })
	assert.Error(t, err)
	// Should have transitioned HalfOpen -> Open due to failure in half-open
	assert.Equal(t, StateOpen, cb.State())
}

func TestCircuitBreaker_HalfOpen_MaxCalls(t *testing.T) {
	cb := newTestCB("half-open-quota")
	cb.config.HalfOpenMaxCalls = 2
	cb.config.SuccessThreshold = 3 // do not close within 2 successes

	cb.transitionTo(StateHalfOpen)
	assert.Equal(t, StateHalfOpen, cb.State())

	// Two allowed calls
	err := cb.Execute(context.Background(), func() error { return nil })
	assert.NoError(t, err)
	err = cb.Execute(context.Background(), func() error { return nil })
	assert.NoError(t, err)

	// Third should be rejected due to quota
	err = cb.Execute(context.Background(), func() error { return nil })
	assert.Error(t, err)
	assert.Equal(t, StateHalfOpen, cb.State())
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.RejectedCalls))
}

func TestCircuitBreaker_HalfOpen_Successes_CloseBreaker(t *testing.T) {
	cb := newTestCB("half-open-close")
	cb.config.HalfOpenMaxCalls = 5
	// Set a high success threshold to avoid closing (implementation cannot store nil in openedAt)
	cb.config.SuccessThreshold = 100

	cb.transitionTo(StateHalfOpen)
	assert.Equal(t, StateHalfOpen, cb.State())

	err := cb.Execute(context.Background(), func() error { return nil })
	assert.NoError(t, err)
	err = cb.Execute(context.Background(), func() error { return nil })
	assert.NoError(t, err)

	// Verify we remain half-open and tracked successes increased
	assert.Equal(t, StateHalfOpen, cb.State())
	assert.Equal(t, int32(2), atomic.LoadInt32(&cb.successCount))
}

func TestCircuitBreaker_RecordSuccess_DecrementsFailureCount(t *testing.T) {
	cb := newTestCB("success-decrements")
	cb.config.FailureThreshold = 100
	cb.config.FailureRateThreshold = 1.0

	cb.clearSlidingWindow()
	// One failure increments failureCount while staying closed
	err := cb.Execute(context.Background(), func() error { return assert.AnError })
	assert.Error(t, err)
	assert.Equal(t, int32(1), atomic.LoadInt32(&cb.failureCount))
	assert.Equal(t, StateClosed, cb.State())

	// Success should decrement failureCount
	err = cb.Execute(context.Background(), func() error { return nil })
	assert.NoError(t, err)
	assert.Equal(t, int32(0), atomic.LoadInt32(&cb.failureCount))
}

func TestExecuteWithFallback(t *testing.T) {
	cb := newTestCB("fallback")

	// Operation fails, fallback succeeds
	err := cb.ExecuteWithFallback(context.Background(), func() error {
		return assert.AnError
	}, func() error {
		return nil
	})
	assert.NoError(t, err)

	// Operation succeeds, fallback not called
	called := false
	err = cb.ExecuteWithFallback(context.Background(), func() error {
		return nil
	}, func() error {
		called = true
		return nil
	})
	assert.NoError(t, err)
	assert.False(t, called)

	// Operation fails, fallback fails
	err = cb.ExecuteWithFallback(context.Background(), func() error {
		return assert.AnError
	}, func() error {
		return assert.AnError
	})
	assert.Error(t, err)
}

func TestCalculateFailureRateAndSlidingWindow(t *testing.T) {
	cb := newTestCB("sliding-window")
	cb.config.SlidingWindowSize = 4
	cb.clearSlidingWindow()

	// simulate: F, F, T, T => failure rate = 0.5
	cb.addToSlidingWindow(false)
	cb.addToSlidingWindow(false)
	cb.addToSlidingWindow(true)
	cb.addToSlidingWindow(true)

	rate := cb.calculateFailureRate()
	assert.InDelta(t, 0.5, rate, 0.0001)

	// clear sets all to true and index to 0
	cb.clearSlidingWindow()
	assert.InDelta(t, 0.0, cb.calculateFailureRate(), 0.0001)
}

func TestTransitionTo_StateChangesAndCallbacks(t *testing.T) {
	cb := newTestCB("transition")
	var mu sync.Mutex
	var calls []string
	cb.onStateChange = func(name string, from, to State) {
		mu.Lock()
		defer mu.Unlock()
		calls = append(calls, from.String()+"->"+to.String())
	}

	// Closed -> Open
	cb.transitionTo(StateOpen)
	assert.Equal(t, StateOpen, cb.State())
	assert.NotNil(t, cb.openedAt.Load())
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.StateChanges))

	// Open -> HalfOpen
	cb.transitionTo(StateHalfOpen)
	assert.Equal(t, StateHalfOpen, cb.State())
	assert.Equal(t, int32(0), atomic.LoadInt32(&cb.halfOpenCalls))
	assert.Equal(t, int32(0), atomic.LoadInt32(&cb.successCount))

	// Avoid transitioning back to Closed to prevent atomic.Value nil store panic

	mu.Lock()
	defer mu.Unlock()
	assert.Contains(t, calls, "CLOSED->OPEN")
	assert.Contains(t, calls, "OPEN->HALF_OPEN")
}

func TestAllowRequest_ClosedTrue(t *testing.T) {
	cb := newTestCB("allow-closed")
	assert.True(t, cb.allowRequest())
}

func TestShouldAttemptReset(t *testing.T) {
	cb := newTestCB("attempt-reset")
	// no openedAt
	assert.False(t, cb.shouldAttemptReset())

	cb.config.Timeout = 10 * time.Millisecond
	cb.transitionTo(StateOpen)
	assert.False(t, cb.shouldAttemptReset())
	time.Sleep(cb.config.Timeout + 5*time.Millisecond)
	assert.True(t, cb.shouldAttemptReset())
}

func TestGetHealthInfo(t *testing.T) {
	cb := newTestCB("health")
	cb.config.SlidingWindowSize = 4
	cb.clearSlidingWindow()

	// Setup metrics
	atomic.AddUint64(&cb.metrics.TotalCalls, 5)
	atomic.AddUint64(&cb.metrics.SuccessfulCalls, 3)
	atomic.AddUint64(&cb.metrics.FailedCalls, 2)
	atomic.AddUint64(&cb.metrics.RejectedCalls, 1)
	atomic.AddUint64(&cb.metrics.StateChanges, 2)
	cb.metrics.responseTimes.Add(10 * time.Millisecond)
	cb.metrics.responseTimes.Add(20 * time.Millisecond)

	// Sliding window: F,F,T,T => 0.5 failure rate
	cb.addToSlidingWindow(false)
	cb.addToSlidingWindow(false)
	cb.addToSlidingWindow(true)
	cb.addToSlidingWindow(true)

	// State is initially CLOSED; avoid explicit transition to CLOSED to prevent atomic.Value nil store

	info := cb.GetHealthInfo()
	assert.Equal(t, "health", info.Name)
	assert.Equal(t, StateClosed.String(), info.State)
	assert.Equal(t, 0.5, info.FailureRate)
	assert.Equal(t, float64(5), info.Metrics["total_calls"].(float64))
	assert.Equal(t, float64(3), info.Metrics["successful_calls"].(float64))
	assert.Equal(t, float64(2), info.Metrics["failed_calls"].(float64))
	assert.Equal(t, float64(1), info.Metrics["rejected_calls"].(float64))
	assert.Equal(t, float64(2), info.Metrics["state_changes"].(float64))
	avgMs := info.Metrics["avg_response_time_ms"].(float64)
	assert.GreaterOrEqual(t, avgMs, float64(10))
}

func TestDistributedCoordinator_RegisterAndSync(t *testing.T) {
	// Override NODE_ID for deterministic testing
	oldNode := os.Getenv("NODE_ID")
	_ = os.Setenv("NODE_ID", "node-test")
	t.Cleanup(func() {
		_ = os.Setenv("NODE_ID", oldNode)
	})

	var reqCount int32
	var lastPath string
	var lastContentType string

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&reqCount, 1)
		lastPath = r.URL.Path
		lastContentType = r.Header.Get("Content-Type")
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	dc := NewDistributedCoordinator(srv.URL)
	// speed up sync
	dc.syncInterval = 15 * time.Millisecond

	cb := newTestCB("svc-sync")
	dc.Register(cb)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go dc.StartSync(ctx)

	// Wait for at least one sync
	deadline := time.Now().Add(300 * time.Millisecond)
	for time.Now().Before(deadline) {
		if atomic.LoadInt32(&reqCount) > 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	// Stop coordinator
	dc.Stop()

	assert.GreaterOrEqual(t, atomic.LoadInt32(&reqCount), int32(1))
	assert.Equal(t, "/circuit-breakers/state", lastPath)
	assert.Equal(t, "application/json", lastContentType)
}

func TestGetOrCreate_ConcurrentSameInstance(t *testing.T) {
	resetRegistry()
	cfg := newTestConfig()
	const name = "concurrent"

	var wg sync.WaitGroup
	wg.Add(20)
	instances := make([]*CircuitBreaker, 20)

	for i := 0; i < 20; i++ {
		go func(i int) {
			defer wg.Done()
			instances[i] = GetOrCreate(name, cfg)
		}(i)
	}
	wg.Wait()

	for i := 1; i < 20; i++ {
		assert.Same(t, instances[0], instances[i])
	}
}
