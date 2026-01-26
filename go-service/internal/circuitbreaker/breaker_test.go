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

func newCBForTest(name string, cfg Config) *CircuitBreaker {
	cb := New(name, cfg)
	// Ensure sliding window is initialized to successes to avoid non-zero initial failure rate
	cb.transitionTo(StateClosed)
	return cb
}

func TestState_StringValues(t *testing.T) {
	assert.Equal(t, "CLOSED", StateClosed.String())
	assert.Equal(t, "OPEN", StateOpen.String())
	assert.Equal(t, "HALF_OPEN", StateHalfOpen.String())
	assert.Equal(t, "UNKNOWN", State(999).String())
}

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
	assert.Equal(t, 30*time.Millisecond, rb.Average()) // (40+20+30)/3
}

func TestCircuitBreaker_Execute_Success(t *testing.T) {
	cfg := Config{
		FailureThreshold:     3,
		SuccessThreshold:     2,
		Timeout:              5 * time.Millisecond,
		HalfOpenMaxCalls:     2,
		SlidingWindowSize:    10,
		FailureRateThreshold: 0.5,
	}
	cb := newCBForTest("execute-success", cfg)

	err := cb.Execute(context.Background(), func() error {
		time.Sleep(5 * time.Millisecond)
		return nil
	})
	assert.NoError(t, err)
	assert.Equal(t, StateClosed, cb.State())
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.TotalCalls))
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.SuccessfulCalls))
	assert.Equal(t, uint64(0), atomic.LoadUint64(&cb.metrics.FailedCalls))
	assert.GreaterOrEqual(t, cb.metrics.responseTimes.Average(), time.Duration(0))
}

func TestCircuitBreaker_Execute_FailureThreshold_Open(t *testing.T) {
	cfg := Config{
		FailureThreshold:     2,
		SuccessThreshold:     2,
		Timeout:              0,
		HalfOpenMaxCalls:     1,
		SlidingWindowSize:    10,
		FailureRateThreshold: 1.0, // high so only threshold triggers
	}
	cb := newCBForTest("failure-threshold", cfg)

	errA := errors.New("op failed")
	_ = cb.Execute(context.Background(), func() error { return errA })
	assert.Equal(t, StateClosed, cb.State())
	_ = cb.Execute(context.Background(), func() error { return errA })
	assert.Equal(t, StateOpen, cb.State())
	assert.Equal(t, uint64(2), atomic.LoadUint64(&cb.metrics.FailedCalls))
	assert.GreaterOrEqual(t, atomic.LoadUint64(&cb.metrics.StateChanges), uint64(1))
}

func TestCircuitBreaker_Execute_FailureRate_Open(t *testing.T) {
	cfg := Config{
		FailureThreshold:     100, // make threshold irrelevant
		SuccessThreshold:     2,
		Timeout:              0,
		HalfOpenMaxCalls:     1,
		SlidingWindowSize:    4,
		FailureRateThreshold: 0.5,
	}
	cb := newCBForTest("failure-rate", cfg)

	errA := errors.New("op failed")
	// Two failures should reach 2/4 = 0.5 rate
	_ = cb.Execute(context.Background(), func() error { return errA })
	assert.Equal(t, StateClosed, cb.State())
	_ = cb.Execute(context.Background(), func() error { return errA })
	assert.Equal(t, StateOpen, cb.State())
}

func TestCircuitBreaker_HalfOpen_AllowRequest_Limit(t *testing.T) {
	cfg := Config{
		FailureThreshold:     1,
		SuccessThreshold:     10,
		Timeout:              0, // immediate attempt reset
		HalfOpenMaxCalls:     2,
		SlidingWindowSize:    5,
		FailureRateThreshold: 0.9,
	}
	cb := newCBForTest("halfopen-limit", cfg)
	cb.transitionTo(StateOpen)

	// First allowRequest on OPEN transitions to HALF_OPEN and returns true
	assert.True(t, cb.allowRequest())
	assert.Equal(t, StateHalfOpen, cb.State())

	// Next two calls within limit
	assert.True(t, cb.allowRequest())
	assert.True(t, cb.allowRequest())

	// Exceeding limit
	assert.False(t, cb.allowRequest())
}

func TestCircuitBreaker_HalfOpen_Successes_TransitionToClosed(t *testing.T) {
	cfg := Config{
		FailureThreshold:     1,
		SuccessThreshold:     2,
		Timeout:              0, // immediate attempt reset
		HalfOpenMaxCalls:     5,
		SlidingWindowSize:    5,
		FailureRateThreshold: 0.9,
	}
	cb := newCBForTest("halfopen-success", cfg)

	// Open the breaker
	cb.transitionTo(StateOpen)

	// First call should transition to HALF_OPEN and allow, then success increments successCount
	err := cb.Execute(context.Background(), func() error { return nil })
	assert.NoError(t, err)
	assert.Equal(t, StateHalfOpen, cb.State())

	// Second success should close the breaker
	err = cb.Execute(context.Background(), func() error { return nil })
	assert.NoError(t, err)
	assert.Equal(t, StateClosed, cb.State())
}

func TestCircuitBreaker_HalfOpen_Failure_GoesOpen(t *testing.T) {
	cfg := Config{
		FailureThreshold:     3,
		SuccessThreshold:     2,
		Timeout:              0, // immediate attempt reset
		HalfOpenMaxCalls:     5,
		SlidingWindowSize:    5,
		FailureRateThreshold: 0.9,
	}
	cb := newCBForTest("halfopen-failure", cfg)

	cb.transitionTo(StateOpen)
	assert.Equal(t, StateOpen, cb.State())

	err := cb.Execute(context.Background(), func() error { return errors.New("fail") })
	assert.Error(t, err)
	// Since it was in HALF_OPEN during execution, failure should transition back to OPEN
	assert.Equal(t, StateOpen, cb.State())
}

func TestCircuitBreaker_ExecuteWithFallback_OnError(t *testing.T) {
	cfg := Config{
		FailureThreshold:     10,
		SuccessThreshold:     2,
		Timeout:              5 * time.Millisecond,
		HalfOpenMaxCalls:     2,
		SlidingWindowSize:    10,
		FailureRateThreshold: 0.9,
	}
	cb := newCBForTest("fallback-error", cfg)

	primaryErr := errors.New("primary failed")
	calledFallback := false
	err := cb.ExecuteWithFallback(context.Background(),
		func() error { return primaryErr },
		func() error { calledFallback = true; return nil },
	)
	assert.NoError(t, err)
	assert.True(t, calledFallback)
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.FailedCalls))
}

func TestCircuitBreaker_ExecuteWithFallback_WhenOpen_Rejected_TriggersFallback(t *testing.T) {
	cfg := Config{
		FailureThreshold:     1,
		SuccessThreshold:     2,
		Timeout:              time.Hour, // keep open
		HalfOpenMaxCalls:     1,
		SlidingWindowSize:    5,
		FailureRateThreshold: 0.1,
	}
	cb := newCBForTest("fallback-open", cfg)
	cb.transitionTo(StateOpen)
	assert.Equal(t, StateOpen, cb.State())

	calledFallback := false
	err := cb.ExecuteWithFallback(context.Background(),
		func() error { return nil }, // shouldn't be called
		func() error { calledFallback = true; return nil },
	)
	assert.NoError(t, err)
	assert.True(t, calledFallback)
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.RejectedCalls))
	// TotalCalls should not increment on rejection
	assert.Equal(t, uint64(0), atomic.LoadUint64(&cb.metrics.TotalCalls))
}

func TestCircuitBreaker_GetHealthInfo_Values(t *testing.T) {
	cfg := Config{
		FailureThreshold:     2,
		SuccessThreshold:     2,
		Timeout:              0,
		HalfOpenMaxCalls:     2,
		SlidingWindowSize:    4,
		FailureRateThreshold: 0.5,
	}
	cb := newCBForTest("health-info", cfg)

	_ = cb.Execute(context.Background(), func() error { return nil })
	_ = cb.Execute(context.Background(), func() error { return errors.New("x") })

	hi := cb.GetHealthInfo()
	assert.Equal(t, "health-info", hi.Name)
	assert.Contains(t, []string{"CLOSED", "OPEN", "HALF_OPEN"}, hi.State)
	assert.GreaterOrEqual(t, hi.FailureCount, 0)
	assert.GreaterOrEqual(t, hi.SuccessCount, 0)
	assert.GreaterOrEqual(t, hi.FailureRate, 0.0)
	assert.NotNil(t, hi.Metrics)
	assert.GreaterOrEqual(t, hi.Metrics["total_calls"].(uint64), uint64(2))
	assert.Equal(t, atomic.LoadUint64(&cb.metrics.SuccessfulCalls), hi.Metrics["successful_calls"].(uint64))
	assert.Equal(t, atomic.LoadUint64(&cb.metrics.FailedCalls), hi.Metrics["failed_calls"].(uint64))
	// avg_response_time_ms is an int64
	_, ok := hi.Metrics["avg_response_time_ms"].(int64)
	assert.True(t, ok)
}

func TestGetOrCreate_ReturnsSameInstance(t *testing.T) {
	cfg := Config{
		FailureThreshold:     3,
		SuccessThreshold:     3,
		Timeout:              10 * time.Millisecond,
		HalfOpenMaxCalls:     3,
		SlidingWindowSize:    5,
		FailureRateThreshold: 0.5,
	}
	name := "getorcreate-" + time.Now().Format("150405.000000000")
	cb1 := GetOrCreate(name, cfg)
	cb2 := GetOrCreate(name, cfg)
	assert.Same(t, cb1, cb2)
}

func TestDistributedCoordinator_RegisterAndSyncReportsState(t *testing.T) {
	var hits int32
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/circuit-breakers/state" && r.Method == http.MethodPost {
			atomic.AddInt32(&hits, 1)
			assert.Equal(t, "application/json", r.Header.Get("Content-Type"))
			w.WriteHeader(http.StatusOK)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer ts.Close()

	dc := NewDistributedCoordinator(ts.URL)
	dc.syncInterval = 10 * time.Millisecond

	cfg := Config{
		FailureThreshold:     2,
		SuccessThreshold:     2,
		Timeout:              0,
		HalfOpenMaxCalls:     1,
		SlidingWindowSize:    4,
		FailureRateThreshold: 0.5,
	}
	cb := newCBForTest("service-A", cfg)
	dc.Register(cb)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go dc.StartSync(ctx)

	time.Sleep(50 * time.Millisecond)
	cancel()
	dc.Stop()

	assert.GreaterOrEqual(t, atomic.LoadInt32(&hits), int32(1))
}
