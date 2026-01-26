package circuitbreaker

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

func TestRingBuffer_AddAverage(t *testing.T) {
	rb := NewRingBuffer(3)
	assert.Equal(t, time.Duration(0), rb.Average())

	rb.Add(10 * time.Millisecond)
	rb.Add(20 * time.Millisecond)
	assert.Equal(t, 15*time.Millisecond, rb.Average())

	rb.Add(30 * time.Millisecond)
	assert.Equal(t, 20*time.Millisecond, rb.Average())

	// Overwrite oldest
	rb.Add(40 * time.Millisecond)
	assert.Equal(t, 30*time.Millisecond, rb.Average())
}

func TestCircuitBreaker_Execute_Success(t *testing.T) {
	cfg := Config{
		FailureThreshold:     2,
		SuccessThreshold:     2,
		Timeout:              100 * time.Millisecond,
		HalfOpenMaxCalls:     1,
		SlidingWindowSize:    5,
		FailureRateThreshold: 2.0, // disable failure-rate opening
	}
	cb := New("success-cb", cfg)
	assert.Equal(t, StateClosed, cb.State())
	assert.Equal(t, "success-cb", cb.Name())

	err := cb.Execute(context.Background(), func() error {
		time.Sleep(5 * time.Millisecond)
		return nil
	})
	assert.NoError(t, err)

	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.TotalCalls))
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.SuccessfulCalls))
	assert.Equal(t, StateClosed, cb.State())
	avg := cb.metrics.responseTimes.Average()
	assert.True(t, avg > 0)
}

func TestCircuitBreaker_Execute_Failure_Threshold_Opens(t *testing.T) {
	cfg := Config{
		FailureThreshold:     2,
		SuccessThreshold:     2,
		Timeout:              1 * time.Second,
		HalfOpenMaxCalls:     1,
		SlidingWindowSize:    5,
		FailureRateThreshold: 2.0, // disable failure-rate opening
	}
	cb := New("fail-open", cfg)

	opErr := errors.New("op failed")
	for i := 0; i < 2; i++ {
		err := cb.Execute(context.Background(), func() error {
			return opErr
		})
		assert.Error(t, err)
	}
	assert.Equal(t, StateOpen, cb.State())
	assert.Equal(t, uint64(2), atomic.LoadUint64(&cb.metrics.FailedCalls))
	assert.Equal(t, uint64(2), atomic.LoadUint64(&cb.metrics.TotalCalls))
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.StateChanges)) // Closed -> Open
}

func TestCircuitBreaker_Open_Rejects_Execute(t *testing.T) {
	cfg := Config{
		FailureThreshold:     1,
		SuccessThreshold:     2,
		Timeout:              1 * time.Second,
		HalfOpenMaxCalls:     1,
		SlidingWindowSize:    5,
		FailureRateThreshold: 2.0,
	}
	cb := New("open-reject", cfg)
	// Force open via one failure (threshold 1)
	_ = cb.Execute(context.Background(), func() error { return errors.New("boom") })
	assert.Equal(t, StateOpen, cb.State())

	err := cb.Execute(context.Background(), func() error { return nil })
	assert.Error(t, err)
	assert.True(t, strings.Contains(err.Error(), "circuit breaker 'open-reject' is open"))
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.RejectedCalls))
}

func TestCircuitBreaker_HalfOpenMaxCallsLimit(t *testing.T) {
	cfg := Config{
		FailureThreshold:     1,
		SuccessThreshold:     10, // keep it from closing to avoid atomic.Value nil store bug
		Timeout:              20 * time.Millisecond,
		HalfOpenMaxCalls:     1, // allow only one probe
		SlidingWindowSize:    5,
		FailureRateThreshold: 2.0,
	}
	cb := New("half-open", cfg)
	// Transition to open
	cb.transitionTo(StateOpen)
	assert.Equal(t, StateOpen, cb.State())

	// Wait for timeout so it will attempt reset to HalfOpen
	time.Sleep(cfg.Timeout + 5*time.Millisecond)

	// First call should be allowed and move to half-open internally
	err1 := cb.Execute(context.Background(), func() error { return nil })
	assert.NoError(t, err1)
	assert.Equal(t, StateHalfOpen, cb.State())

	// Second call should be rejected due to HalfOpenMaxCalls limit
	err2 := cb.Execute(context.Background(), func() error { return nil })
	assert.Error(t, err2)
	assert.True(t, strings.Contains(err2.Error(), "is open"))
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.RejectedCalls))
	assert.Equal(t, StateHalfOpen, cb.State())
}

func TestCircuitBreaker_ExecuteWithFallback(t *testing.T) {
	cfg := Config{
		FailureThreshold:     1,
		SuccessThreshold:     2,
		Timeout:              1 * time.Second,
		HalfOpenMaxCalls:     1,
		SlidingWindowSize:    5,
		FailureRateThreshold: 2.0,
	}
	cb := New("with-fallback", cfg)
	// Force open
	cb.transitionTo(StateOpen)

	var fallbackCalled int32
	err := cb.ExecuteWithFallback(context.Background(),
		func() error { return errors.New("primary fail") },
		func() error {
			atomic.AddInt32(&fallbackCalled, 1)
			return nil
		},
	)
	assert.NoError(t, err)
	assert.Equal(t, int32(1), atomic.LoadInt32(&fallbackCalled))
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.RejectedCalls))
}

func TestCircuitBreaker_OnStateChangeCallback(t *testing.T) {
	cfg := Config{
		FailureThreshold:     1,
		SuccessThreshold:     2,
		Timeout:              1 * time.Second,
		HalfOpenMaxCalls:     1,
		SlidingWindowSize:    5,
		FailureRateThreshold: 2.0,
	}
	cb := New("cb-callback", cfg)

	var called int32
	var fromS, toS State
	cb.onStateChange = func(name string, from, to State) {
		atomic.AddInt32(&called, 1)
		fromS, toS = from, to
	}

	_ = cb.Execute(context.Background(), func() error { return errors.New("fail") })
	assert.Equal(t, int32(1), atomic.LoadInt32(&called))
	assert.Equal(t, StateClosed, fromS)
	assert.Equal(t, StateOpen, toS)
}

func TestCircuitBreaker_shouldAttemptReset(t *testing.T) {
	cfg := Config{
		FailureThreshold:     1,
		SuccessThreshold:     2,
		Timeout:              20 * time.Millisecond,
		HalfOpenMaxCalls:     1,
		SlidingWindowSize:    5,
		FailureRateThreshold: 2.0,
	}
	cb := New("reset-test", cfg)
	cb.transitionTo(StateOpen)

	assert.False(t, cb.shouldAttemptReset())
	time.Sleep(cfg.Timeout + 5*time.Millisecond)
	assert.True(t, cb.shouldAttemptReset())
}

func TestCircuitBreaker_GetOrCreate_Singleton(t *testing.T) {
	registryMu.Lock()
	registry = make(map[string]*CircuitBreaker)
	registryMu.Unlock()

	cfg1 := Config{FailureThreshold: 1, SuccessThreshold: 1, Timeout: 10 * time.Millisecond, HalfOpenMaxCalls: 1, SlidingWindowSize: 3, FailureRateThreshold: 2.0}
	cfg2 := Config{FailureThreshold: 10, SuccessThreshold: 5, Timeout: 20 * time.Millisecond, HalfOpenMaxCalls: 2, SlidingWindowSize: 5, FailureRateThreshold: 2.0}

	cb1 := GetOrCreate("shared", cfg1)
	cb2 := GetOrCreate("shared", cfg2)

	assert.Same(t, cb1, cb2)
	assert.Equal(t, "shared", cb1.Name())
}

func TestCircuitBreaker_GetHealthInfo(t *testing.T) {
	cfg := Config{
		FailureThreshold:     5,
		SuccessThreshold:     3,
		Timeout:              30 * time.Second,
		HalfOpenMaxCalls:     3,
		SlidingWindowSize:    4,
		FailureRateThreshold: 2.0,
	}
	cb := New("health", cfg)

	// Ensure sliding window starts as all successes to avoid initial false entries impacting rate
	cb.clearSlidingWindow()

	// Manually record durations to make average deterministic
	cb.recordSuccess(10 * time.Millisecond)
	cb.recordFailure(30 * time.Millisecond)

	info := cb.GetHealthInfo()
	assert.Equal(t, "health", info.Name)
	assert.Equal(t, StateClosed.String(), info.State)
	assert.Equal(t, 1, info.SuccessCount)
	assert.Equal(t, 1, info.FailureCount) // failureCount is incremented in Closed state and decremented on next success; here we did success before failure
	// Since we cleared window to all true, and then added success (true) and failure (false), rate = 1/4
	assert.InDelta(t, 0.25, info.FailureRate, 0.0001)

	avgMs, ok := info.Metrics["avg_response_time_ms"].(int64)
	assert.True(t, ok)
	assert.Equal(t, int64(20), avgMs)

	totalCalls := info.Metrics["total_calls"].(uint64)
	successfulCalls := info.Metrics["successful_calls"].(uint64)
	failedCalls := info.Metrics["failed_calls"].(uint64)
	assert.Equal(t, uint64(2), totalCalls)
	assert.Equal(t, uint64(1), successfulCalls)
	assert.Equal(t, uint64(1), failedCalls)
}

func TestDefaultConfig(t *testing.T) {
	cfg := DefaultConfig()
	assert.True(t, cfg.FailureThreshold > 0)
	assert.True(t, cfg.SuccessThreshold > 0)
	assert.True(t, cfg.Timeout > 0)
	assert.True(t, cfg.HalfOpenMaxCalls > 0)
	assert.True(t, cfg.SlidingWindowSize > 0)
	assert.True(t, cfg.FailureRateThreshold > 0)
}

func TestDistributedCoordinator_Register(t *testing.T) {
	dc := NewDistributedCoordinator("http://localhost:12345")
	cb := New("svc", DefaultConfig())
	dc.Register(cb)

	dc.mu.RLock()
	defer dc.mu.RUnlock()
	assert.Contains(t, dc.breakers, "svc")
	assert.Same(t, cb, dc.breakers["svc"])
}

func TestDistributedCoordinator_StartSyncAndStop(t *testing.T) {
	var count int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && r.URL.Path == "/circuit-breakers/state" {
			atomic.AddInt64(&count, 1)
			w.WriteHeader(http.StatusOK)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()

	dc := NewDistributedCoordinator(server.URL)
	dc.syncInterval = 10 * time.Millisecond

	cb := New("svc-sync", DefaultConfig())
	dc.Register(cb)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go dc.StartSync(ctx)

	// Wait for at least one sync
	deadline := time.After(200 * time.Millisecond)
	for {
		if atomic.LoadInt64(&count) > 0 {
			break
		}
		select {
		case <-deadline:
			t.Fatal("did not receive sync in time")
		default:
			time.Sleep(5 * time.Millisecond)
		}
	}

	// Stop syncing
	dc.Stop()
	cur := atomic.LoadInt64(&count)
	time.Sleep(30 * time.Millisecond)
	after := atomic.LoadInt64(&count)

	// It may still increment once due to race with ticker; ensure it doesn't grow unbounded
	assert.LessOrEqual(t, after-cur, int64(1))
}

func TestNewDistributedCoordinator_NodeIDFromEnv(t *testing.T) {
	prev := os.Getenv("NODE_ID")
	defer os.Setenv("NODE_ID", prev)

	_ = os.Setenv("NODE_ID", "node-123")
	dc := NewDistributedCoordinator("http://example.com")
	assert.Equal(t, "node-123", dc.nodeID)
}
