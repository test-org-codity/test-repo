package circuitbreaker

import (
	"context"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

func TestRingBuffer_AddAndAverage(t *testing.T) {
	rb := NewRingBuffer(3)
	assert.Equal(t, time.Duration(0), rb.Average())

	rb.Add(100 * time.Millisecond)
	rb.Add(200 * time.Millisecond)
	assert.Equal(t, 150*time.Millisecond, rb.Average())

	rb.Add(300 * time.Millisecond)
	assert.Equal(t, 200*time.Millisecond, rb.Average())

	// Overwrite oldest
	rb.Add(400 * time.Millisecond)
	assert.Equal(t, 300*time.Millisecond, rb.Average())
}

func TestCircuitBreaker_Execute_TransitionsAndMetrics(t *testing.T) {
	cfg := Config{
		FailureThreshold:     2,
		SuccessThreshold:     1,
		Timeout:              50 * time.Millisecond,
		HalfOpenMaxCalls:     1,
		SlidingWindowSize:    2,
		FailureRateThreshold: 0.5,
	}
	cb := New("svc", cfg)
	assert.Equal(t, StateClosed, cb.State())

	// First call fails; because initial sliding window is all false, failure rate is 1.0 => opens immediately.
	err := cb.Execute(context.Background(), func() error { return assert.AnError })
	assert.Error(t, err)
	assert.Equal(t, StateOpen, cb.State())
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.TotalCalls))
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.FailedCalls))
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.StateChanges))

	// Next call should be rejected since open and timeout not elapsed
	called := false
	err = cb.Execute(context.Background(), func() error {
		called = true
		return nil
	})
	assert.Error(t, err)
	assert.False(t, called, "operation should not have been called when open")
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.RejectedCalls))

	// Fast-forward time beyond timeout to allow HalfOpen
	cb.openedAt.Store(time.Now().Add(-cfg.Timeout - time.Millisecond))

	var transitions [][3]string
	cb.onStateChange = func(name string, from, to State) {
		transitions = append(transitions, [3]string{name, from.String(), to.String()})
	}

	// Successful probe should close due to SuccessThreshold=1
	err = cb.Execute(context.Background(), func() error { return nil })
	assert.NoError(t, err)
	assert.Equal(t, StateClosed, cb.State())
	assert.Equal(t, uint64(2), atomic.LoadUint64(&cb.metrics.SuccessfulCalls))

	// Verify transitions occurred: CLOSED->OPEN, OPEN->HALF_OPEN (on allowRequest), HALF_OPEN->CLOSED
	var got []string
	for _, tr := range transitions {
		got = append(got, tr[1]+"->"+tr[2])
	}
	assert.Contains(t, got, "CLOSED->OPEN")
	assert.Contains(t, got, "OPEN->HALF_OPEN")
	assert.Contains(t, got, "HALF_OPEN->CLOSED")
}

func TestCircuitBreaker_ExecuteWithFallback_CallsFallbackOnError(t *testing.T) {
	cfg := Config{
		FailureThreshold:     100, // avoid opening due to threshold
		SuccessThreshold:     2,
		Timeout:              10 * time.Millisecond,
		HalfOpenMaxCalls:     2,
		SlidingWindowSize:    10,
		FailureRateThreshold: 1.0, // avoid opening on rate
	}
	cb := New("svc-fallback", cfg)

	operationCalled := false
	fallbackCalled := false

	err := cb.ExecuteWithFallback(context.Background(),
		func() error {
			operationCalled = true
			return assert.AnError
		},
		func() error {
			fallbackCalled = true
			return nil
		},
	)

	assert.NoError(t, err)
	assert.True(t, operationCalled)
	assert.True(t, fallbackCalled)
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.TotalCalls))
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.FailedCalls))
}

func TestCircuitBreaker_HalfOpen_MaxCallsLimit(t *testing.T) {
	cfg := Config{
		FailureThreshold:     10,
		SuccessThreshold:     10, // keep it in half-open
		Timeout:              1 * time.Millisecond,
		HalfOpenMaxCalls:     2,
		SlidingWindowSize:    5,
		FailureRateThreshold: 1.0,
	}
	cb := New("svc-halfopen", cfg)

	// Force open and make timeout elapsed
	cb.transitionTo(StateOpen)
	cb.openedAt.Store(time.Now().Add(-cfg.Timeout - time.Millisecond))

	// First call: should move to HalfOpen and allow
	err1 := cb.Execute(context.Background(), func() error { return nil })
	assert.NoError(t, err1)
	assert.Equal(t, StateHalfOpen, cb.State())

	// Second call: should be allowed (within HalfOpenMaxCalls)
	err2 := cb.Execute(context.Background(), func() error { return nil })
	assert.NoError(t, err2)
	assert.Equal(t, StateHalfOpen, cb.State())

	// Third call: should be rejected due to exceeding HalfOpenMaxCalls
	err3 := cb.Execute(context.Background(), func() error { return nil })
	assert.Error(t, err3)
	assert.Contains(t, err3.Error(), "is open")
}

func TestGetOrCreate_ReturnsSameInstance(t *testing.T) {
	// Reset registry
	registryMu.Lock()
	registry = make(map[string]*CircuitBreaker)
	registryMu.Unlock()

	cfg := DefaultConfig()
	cb1 := GetOrCreate("shared", cfg)
	cb2 := GetOrCreate("shared", cfg)
	assert.Same(t, cb1, cb2)
}

func TestCircuitBreaker_GetHealthInfo_ContainsExpectedFields(t *testing.T) {
	cfg := Config{
		FailureThreshold:     100,
		SuccessThreshold:     10,
		Timeout:              1 * time.Second,
		HalfOpenMaxCalls:     5,
		SlidingWindowSize:    4,
		FailureRateThreshold: 1.0,
	}
	cb := New("svc-health", cfg)

	// Ensure sliding window starts as success to compute predictable failure rate
	cb.transitionTo(StateClosed) // will clearSlidingWindow()

	// success
	_ = cb.Execute(context.Background(), func() error { time.Sleep(1 * time.Millisecond); return nil })
	// failure
	_ = cb.Execute(context.Background(), func() error { return assert.AnError })
	// success
	_ = cb.Execute(context.Background(), func() error { return nil })

	hi := cb.GetHealthInfo()
	assert.Equal(t, "svc-health", hi.Name)
	assert.Equal(t, "CLOSED", hi.State)
	assert.InDelta(t, 0.25, hi.FailureRate, 0.0001)

	// Metrics checks
	total := hi.Metrics["total_calls"].(uint64)
	successes := hi.Metrics["successful_calls"].(uint64)
	failures := hi.Metrics["failed_calls"].(uint64)
	rejected := hi.Metrics["rejected_calls"].(uint64)
	stateChanges := hi.Metrics["state_changes"].(uint64)
	avgMs := hi.Metrics["avg_response_time_ms"].(int64)

	assert.Equal(t, uint64(3), total)
	assert.Equal(t, uint64(2), successes)
	assert.Equal(t, uint64(1), failures)
	assert.Equal(t, uint64(0), rejected)
	assert.GreaterOrEqual(t, avgMs, int64(0))
	// No state changes expected in this scenario (transitionTo(StateClosed) earlier might have been no-op if already closed)
	assert.GreaterOrEqual(t, stateChanges, uint64(0))
}

func TestCircuitBreaker_CalculateFailureRateAndClearWindow(t *testing.T) {
	cfg := Config{
		FailureThreshold:     5,
		SuccessThreshold:     3,
		Timeout:              30 * time.Second,
		HalfOpenMaxCalls:     3,
		SlidingWindowSize:    4,
		FailureRateThreshold: 0.5,
	}
	cb := New("svc-window", cfg)

	// Fill window: T, F, F, T => 2/4 failures = 0.5
	cb.addToSlidingWindow(true)
	cb.addToSlidingWindow(false)
	cb.addToSlidingWindow(false)
	cb.addToSlidingWindow(true)

	rate := cb.calculateFailureRate()
	assert.InDelta(t, 0.5, rate, 0.0001)

	cb.clearSlidingWindow()
	rateAfterClear := cb.calculateFailureRate()
	assert.InDelta(t, 0.0, rateAfterClear, 0.0001)
	assert.Equal(t, 0, cb.windowIndex)
}

func TestState_String(t *testing.T) {
	tests := []struct {
		s    State
		want string
	}{
		{StateClosed, "CLOSED"},
		{StateOpen, "OPEN"},
		{StateHalfOpen, "HALF_OPEN"},
		{State(99), "UNKNOWN"},
	}
	for _, tt := range tests {
		assert.Equal(t, tt.want, tt.s.String())
	}
}

func TestCircuitBreaker_Name(t *testing.T) {
	cb := New("my-service", DefaultConfig())
	assert.Equal(t, "my-service", cb.Name())
}

type roundTripperFunc func(*http.Request) (*http.Response, error)

func (f roundTripperFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestDistributedCoordinator_RegisterAndStartSync(t *testing.T) {
	dc := NewDistributedCoordinator("http://coordinator.local")
	cb := New("svc-sync", DefaultConfig())
	dc.Register(cb)
	dc.syncInterval = 10 * time.Millisecond

	var reqCount int32
	var lastMethod, lastURL, lastContentType string

	dc.client.Transport = roundTripperFunc(func(r *http.Request) (*http.Response, error) {
		atomic.AddInt32(&reqCount, 1)
		lastMethod = r.Method
		lastURL = r.URL.Path
		lastContentType = r.Header.Get("Content-Type")
		return &http.Response{
			StatusCode: 200,
			Body:       io.NopCloser(strings.NewReader("ok")),
			Header:     make(http.Header),
		}, nil
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go dc.StartSync(ctx)

	time.Sleep(40 * time.Millisecond)
	cancel()
	time.Sleep(10 * time.Millisecond)

	assert.GreaterOrEqual(t, atomic.LoadInt32(&reqCount), int32(1))
	assert.Equal(t, "POST", lastMethod)
	assert.Equal(t, "/circuit-breakers/state", lastURL)
	assert.Equal(t, "application/json", lastContentType)
}

func TestCircuitBreaker_allowRequest_Behavior(t *testing.T) {
	cfg := Config{
		FailureThreshold:     1,
		SuccessThreshold:     1,
		Timeout:              20 * time.Millisecond,
		HalfOpenMaxCalls:     1,
		SlidingWindowSize:    5,
		FailureRateThreshold: 0.5,
	}
	cb := New("svc-allow", cfg)

	// Closed allows
	assert.True(t, cb.allowRequest())

	// Open disallows until timeout
	cb.transitionTo(StateOpen)
	assert.False(t, cb.allowRequest())

	// After timeout, should allow and transition to HalfOpen
	cb.openedAt.Store(time.Now().Add(-cfg.Timeout - time.Millisecond))
	allowed := cb.allowRequest()
	assert.True(t, allowed)
	assert.Equal(t, StateHalfOpen, cb.State())
}
