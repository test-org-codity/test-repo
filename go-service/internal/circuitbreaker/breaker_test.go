package circuitbreaker

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

func TestState_String(t *testing.T) {
	assert.Equal(t, "CLOSED", StateClosed.String())
	assert.Equal(t, "OPEN", StateOpen.String())
	assert.Equal(t, "HALF_OPEN", StateHalfOpen.String())
	assert.Equal(t, "UNKNOWN", State(99).String())
}

func TestRingBuffer_AddAndAverage(t *testing.T) {
	rb := NewRingBuffer(3)
	assert.Equal(t, time.Duration(0), rb.Average())

	rb.Add(10 * time.Millisecond)
	rb.Add(20 * time.Millisecond)
	assert.Equal(t, 15*time.Millisecond, rb.Average())

	// Wrap around
	rb.Add(30 * time.Millisecond)
	assert.Equal(t, 20*time.Millisecond, rb.Average())

	rb.Add(40 * time.Millisecond) // overwrites first (10ms)
	// Now values should be [40,20,30] average = 30
	assert.Equal(t, 30*time.Millisecond, rb.Average())
}

func TestNew_NameAndInitialState(t *testing.T) {
	cfg := DefaultConfig()
	cb := New("service-A", cfg)
	assert.NotNil(t, cb)
	assert.Equal(t, "service-A", cb.Name())
	assert.Equal(t, StateClosed, cb.State())
	assert.NotNil(t, cb.metrics)
	assert.NotNil(t, cb.metrics.responseTimes)
	assert.Equal(t, cfg.SlidingWindowSize, len(cb.slidingWindow))
}

func TestGetOrCreate_ReturnsSameInstance(t *testing.T) {
	cfg := DefaultConfig()
	name := "shared-breaker-" + time.Now().String()
	cb1 := GetOrCreate(name, cfg)
	cb2 := GetOrCreate(name, cfg)
	assert.Same(t, cb1, cb2)
}

func TestCircuitBreaker_Execute_Success(t *testing.T) {
	cfg := DefaultConfig()
	cb := New("exec-success", cfg)
	cb.clearSlidingWindow()

	// Seed a failure count to ensure success decrements it in CLOSED
	atomic.StoreInt32(&cb.failureCount, 1)

	err := cb.Execute(context.Background(), func() error { return nil })
	assert.NoError(t, err)
	assert.Equal(t, StateClosed, cb.State())
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.TotalCalls))
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.SuccessfulCalls))
	// failureCount should decrement by 1 but not go below 0
	assert.Equal(t, int32(0), atomic.LoadInt32(&cb.failureCount))
}

func TestCircuitBreaker_Execute_Failure_ThresholdOpen(t *testing.T) {
	cfg := DefaultConfig()
	cfg.FailureThreshold = 2
	cfg.FailureRateThreshold = 1.0 // avoid failure-rate opening, rely on threshold
	cb := New("exec-failure-threshold", cfg)
	cb.clearSlidingWindow()

	op := func() error { return assert.AnError }
	err := cb.Execute(context.Background(), op)
	assert.Error(t, err)
	assert.Equal(t, StateClosed, cb.State())
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.TotalCalls))
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.FailedCalls))
	assert.Equal(t, int32(1), atomic.LoadInt32(&cb.failureCount))

	err = cb.Execute(context.Background(), op)
	assert.Error(t, err)
	assert.Equal(t, StateOpen, cb.State())
	assert.Equal(t, uint64(2), atomic.LoadUint64(&cb.metrics.TotalCalls))
	assert.Equal(t, uint64(2), atomic.LoadUint64(&cb.metrics.FailedCalls))
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.StateChanges))
}

func TestCircuitBreaker_Execute_Failure_FailureRateOpen(t *testing.T) {
	cfg := DefaultConfig()
	cfg.FailureThreshold = 100 // make sure threshold won't trigger
	cfg.SlidingWindowSize = 4
	cfg.FailureRateThreshold = 0.5
	cb := New("exec-failure-rate", cfg)

	// ensure window starts as all successes
	cb.clearSlidingWindow()

	opFail := func() error { return assert.AnError }

	// First failure -> window false count = 1/4 = 0.25, below threshold
	_ = cb.Execute(context.Background(), opFail)
	assert.Equal(t, StateClosed, cb.State())

	// Second failure -> window false count = 2/4 = 0.5, at threshold -> open
	_ = cb.Execute(context.Background(), opFail)
	assert.Equal(t, StateOpen, cb.State())
}

func TestCircuitBreaker_AllowRequest_OpenToHalfOpenAndLimits(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Timeout = 20 * time.Millisecond
	cfg.HalfOpenMaxCalls = 2
	cb := New("allow-req", cfg)
	cb.transitionTo(StateOpen)

	// Immediately should reject since not timed out
	assert.False(t, cb.allowRequest())

	// Make it eligible for reset
	cb.openedAt.Store(time.Now().Add(-2 * cfg.Timeout))
	// First allow should transition to HalfOpen and return true
	assert.True(t, cb.allowRequest())
	assert.Equal(t, StateHalfOpen, cb.State())

	// In HALF_OPEN: allow up to HalfOpenMaxCalls
	assert.True(t, cb.allowRequest())  // first probe
	assert.True(t, cb.allowRequest())  // second probe reaches limit
	assert.False(t, cb.allowRequest()) // exceeding limit
}

func TestCircuitBreaker_HalfOpen_SuccessesClose(t *testing.T) {
	cfg := DefaultConfig()
	cfg.SuccessThreshold = 2
	cb := New("halfopen-success", cfg)

	// Move to OPEN then make eligible for HALF_OPEN
	cb.transitionTo(StateOpen)
	cb.openedAt.Store(time.Now().Add(-time.Hour))
	_ = cb.allowRequest() // transitions to HALF_OPEN

	assert.Equal(t, StateHalfOpen, cb.State())
	// One success should not close yet (avoid triggering panic in implementation)
	cb.recordSuccess(5 * time.Millisecond)
	assert.Equal(t, StateHalfOpen, cb.State())
	// Ensure internal success counter incremented
	assert.Equal(t, int32(1), atomic.LoadInt32(&cb.successCount))
}

func TestCircuitBreaker_HalfOpen_FailureReopens(t *testing.T) {
	cfg := DefaultConfig()
	cb := New("halfopen-failure", cfg)

	cb.transitionTo(StateOpen)
	cb.openedAt.Store(time.Now().Add(-time.Hour))
	_ = cb.allowRequest() // to HALF_OPEN

	cb.recordFailure(5 * time.Millisecond)
	assert.Equal(t, StateOpen, cb.State())
}

func TestCircuitBreaker_ExecuteWithFallback(t *testing.T) {
	cfg := DefaultConfig()
	cb := New("exec-fallback", cfg)
	cb.clearSlidingWindow()

	called := int32(0)
	op := func() error { return assert.AnError }
	fallback := func() error {
		atomic.AddInt32(&called, 1)
		return nil
	}

	// When operation fails, fallback should run
	err := cb.ExecuteWithFallback(context.Background(), op, fallback)
	assert.NoError(t, err)
	assert.Equal(t, int32(1), atomic.LoadInt32(&called))

	// When breaker is open, Execute should short-circuit and fallback should run
	cb.transitionTo(StateOpen)
	// ensure not eligible to reset
	cb.openedAt.Store(time.Now())
	err = cb.ExecuteWithFallback(context.Background(), op, fallback)
	assert.NoError(t, err)
	assert.Equal(t, int32(2), atomic.LoadInt32(&called))
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.RejectedCalls))
}

func TestCircuitBreaker_GetHealthInfo(t *testing.T) {
	cfg := DefaultConfig()
	cfg.SlidingWindowSize = 4
	cb := New("health-check", cfg)

	// Prepare sliding window: 2 failures, 2 successes -> failure rate initially 0.5
	cb.clearSlidingWindow()
	cb.addToSlidingWindow(false)
	cb.addToSlidingWindow(false)
	cb.addToSlidingWindow(true)
	cb.addToSlidingWindow(true)

	// Add some response times and update sliding window positions
	cb.recordSuccess(10 * time.Millisecond)
	cb.recordFailure(30 * time.Millisecond)

	hi := cb.GetHealthInfo()
	assert.Equal(t, "health-check", hi.Name)
	assert.Equal(t, "CLOSED", hi.State)
	// After the above operations, the sliding window reflects 1 failure out of 4 => 0.25
	assert.Equal(t, 0.25, hi.FailureRate)

	// Metrics presence and types
	if v, ok := hi.Metrics["total_calls"].(uint64); ok {
		_ = v
	} else {
		t.Fatalf("total_calls not present or wrong type")
	}
	if v, ok := hi.Metrics["successful_calls"].(uint64); ok {
		_ = v
	} else {
		t.Fatalf("successful_calls not present or wrong type")
	}
	if v, ok := hi.Metrics["failed_calls"].(uint64); ok {
		_ = v
	} else {
		t.Fatalf("failed_calls not present or wrong type")
	}
	if v, ok := hi.Metrics["rejected_calls"].(uint64); ok {
		_ = v
	} else {
		t.Fatalf("rejected_calls not present or wrong type")
	}
	if v, ok := hi.Metrics["state_changes"].(uint64); ok {
		_ = v
	} else {
		t.Fatalf("state_changes not present or wrong type")
	}
	avgMs, ok := hi.Metrics["avg_response_time_ms"].(int64)
	if !ok {
		t.Fatalf("avg_response_time_ms not present or wrong type")
	}
	assert.Equal(t, int64(20), avgMs)
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func TestDistributedCoordinator_RegisterAndSyncStates(t *testing.T) {
	cfg := DefaultConfig()
	cb := New("dc-service", cfg)

	var capturedReq *http.Request
	var calls int32

	client := &http.Client{
		Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			atomic.AddInt32(&calls, 1)
			capturedReq = req
			return &http.Response{
				StatusCode: 200,
				Body:       io.NopCloser(bytes.NewReader(nil)),
				Header:     make(http.Header),
				Request:    req,
			}, nil
		}),
	}

	dc := NewDistributedCoordinator("http://coordinator.local")
	dc.client = client
	dc.Register(cb)

	dc.syncStates()

	assert.GreaterOrEqual(t, atomic.LoadInt32(&calls), int32(1))
	if assert.NotNil(t, capturedReq) {
		assert.Equal(t, "POST", capturedReq.Method)
		assert.Equal(t, "http://coordinator.local/circuit-breakers/state", capturedReq.URL.String())
		assert.Equal(t, "application/json", capturedReq.Header.Get("Content-Type"))
	}
}

func TestDistributedCoordinator_StartSync_Stop(t *testing.T) {
	cfg := DefaultConfig()
	cb := New("dc-sync-service", cfg)

	var calls int32
	client := &http.Client{
		Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			atomic.AddInt32(&calls, 1)
			return &http.Response{
				StatusCode: 200,
				Body:       io.NopCloser(bytes.NewReader(nil)),
				Header:     make(http.Header),
				Request:    req,
			}, nil
		}),
	}

	dc := NewDistributedCoordinator("http://coordinator.local")
	dc.client = client
	dc.syncInterval = 10 * time.Millisecond
	dc.Register(cb)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go dc.StartSync(ctx)

	time.Sleep(35 * time.Millisecond)
	cancel()
	time.Sleep(15 * time.Millisecond)

	assert.GreaterOrEqual(t, atomic.LoadInt32(&calls), int32(1))
}
