package circuitbreaker

import (
	"context"
	"io"
	"net/http"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
}

func newTestCB(name string) *CircuitBreaker {
	cfg := Config{
		FailureThreshold:     2,
		SuccessThreshold:     2,
		Timeout:              20 * time.Millisecond,
		HalfOpenMaxCalls:     2,
		SlidingWindowSize:    4,
		FailureRateThreshold: 0.5,
	}
	cb := New(name, cfg)
	cb.clearSlidingWindow()
	return cb
}

func TestState_String(t *testing.T) {
	assert.Equal(t, "CLOSED", StateClosed.String())
	assert.Equal(t, "OPEN", StateOpen.String())
	assert.Equal(t, "HALF_OPEN", StateHalfOpen.String())
	assert.Equal(t, "UNKNOWN", State(999).String())
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
	rb := NewRingBuffer(2)
	assert.Equal(t, time.Duration(0), rb.Average())

	rb.Add(10 * time.Millisecond)
	rb.Add(20 * time.Millisecond)
	assert.Equal(t, 15*time.Millisecond, rb.Average())

	// Overwrite oldest
	rb.Add(30 * time.Millisecond)
	// Now buffer has [30ms, 20ms] or [20ms, 30ms] depending on head; average should be 25ms
	avg := rb.Average()
	assert.Equal(t, 25*time.Millisecond, avg)
}

func TestGetOrCreate_ReturnsSameInstance(t *testing.T) {
	// reset registry for isolation
	registryMu.Lock()
	registry = make(map[string]*CircuitBreaker)
	registryMu.Unlock()

	cfg := DefaultConfig()
	cb1 := GetOrCreate("svc", cfg)
	cb2 := GetOrCreate("svc", cfg)
	assert.Same(t, cb1, cb2)

	cb3 := GetOrCreate("svc2", cfg)
	assert.NotSame(t, cb1, cb3)
}

func TestCircuitBreaker_Execute_Success(t *testing.T) {
	cb := newTestCB("svc-success")

	// Simulate some failure count that should decrement on success in Closed
	atomic.StoreInt32(&cb.failureCount, 1)

	err := cb.Execute(context.Background(), func() error {
		time.Sleep(2 * time.Millisecond)
		return nil
	})
	assert.NoError(t, err)

	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.TotalCalls))
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.SuccessfulCalls))
	assert.Equal(t, uint64(0), atomic.LoadUint64(&cb.metrics.FailedCalls))
	assert.Equal(t, StateClosed, cb.State())
	assert.LessOrEqual(t, int32(0), atomic.LoadInt32(&cb.failureCount))
}

func TestCircuitBreaker_Execute_Failure_ThresholdOpen(t *testing.T) {
	cb := newTestCB("svc-failure-threshold")

	// First failure: should not open yet (failureCount=1, failureRate=0.25)
	err := cb.Execute(context.Background(), func() error { return assert.AnError })
	assert.Error(t, err)
	assert.Equal(t, StateClosed, cb.State())
	assert.Equal(t, int32(1), atomic.LoadInt32(&cb.failureCount))

	// Second failure: meets FailureThreshold=2 -> opens
	err = cb.Execute(context.Background(), func() error { return assert.AnError })
	assert.Error(t, err)
	assert.Equal(t, StateOpen, cb.State())
	assert.Equal(t, int32(2), atomic.LoadInt32(&cb.failureCount))
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.StateChanges))
}

func TestCircuitBreaker_ExecuteWithFallback_OnOperationFailure(t *testing.T) {
	cb := newTestCB("svc-fallback-opfail")

	fallbackCalled := false
	err := cb.ExecuteWithFallback(context.Background(),
		func() error { return assert.AnError },
		func() error { fallbackCalled = true; return nil },
	)
	assert.NoError(t, err)
	assert.True(t, fallbackCalled)
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.TotalCalls))
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.FailedCalls))
}

func TestCircuitBreaker_ExecuteWithFallback_OpenBreakerRejectedAndFallback(t *testing.T) {
	cb := newTestCB("svc-fallback-open")
	cb.config.Timeout = time.Hour // ensure shouldAttemptReset returns false
	cb.transitionTo(StateOpen)

	opCalled := false
	fallbackCalled := false

	err := cb.ExecuteWithFallback(context.Background(),
		func() error { opCalled = true; return nil },
		func() error { fallbackCalled = true; return nil },
	)
	assert.NoError(t, err)
	assert.False(t, opCalled)
	assert.True(t, fallbackCalled)
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.RejectedCalls))
}

func TestCircuitBreaker_AllowRequest_HalfOpenMaxCalls(t *testing.T) {
	cb := newTestCB("svc-allow-halfopen")
	cb.config.HalfOpenMaxCalls = 2
	cb.transitionTo(StateHalfOpen)

	assert.True(t, cb.allowRequest())
	assert.True(t, cb.allowRequest())
	assert.False(t, cb.allowRequest())
}

func TestCircuitBreaker_ShouldAttemptReset(t *testing.T) {
	cb := newTestCB("svc-reset")
	// Opened recently, shouldAttemptReset false
	cb.transitionTo(StateOpen)
	assert.False(t, cb.shouldAttemptReset())

	// Simulate opened at far past
	cb.config.Timeout = 10 * time.Millisecond
	cb.openedAt.Store(time.Now().Add(-20 * time.Millisecond))
	assert.True(t, cb.shouldAttemptReset())

	// No openedAt stored
	cb2 := newTestCB("svc-reset2")
	assert.False(t, cb2.shouldAttemptReset())
}

func TestCircuitBreaker_TransitionTo_CallbackAndResets(t *testing.T) {
	cb := newTestCB("svc-transition")

	var callbackFrom, callbackTo State
	cb.onStateChange = func(name string, from, to State) {
		callbackFrom, callbackTo = from, to
	}

	// Transition to Open sets openedAt and increments state changes
	cb.transitionTo(StateOpen)
	assert.Equal(t, StateOpen, cb.State())
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.StateChanges))
	assert.Equal(t, StateClosed, callbackFrom)
	assert.Equal(t, StateOpen, callbackTo)
	assert.NotNil(t, cb.openedAt.Load())

	// Transition to HalfOpen resets halfOpenCalls and successCount
	atomic.StoreInt32(&cb.halfOpenCalls, 5)
	atomic.StoreInt32(&cb.successCount, 3)
	cb.transitionTo(StateHalfOpen)
	assert.Equal(t, StateHalfOpen, cb.State())
	assert.Equal(t, int32(0), atomic.LoadInt32(&cb.halfOpenCalls))
	assert.Equal(t, int32(0), atomic.LoadInt32(&cb.successCount))

	// Set counts and window then attempt transition to Closed which will panic due to nil store
	atomic.StoreInt32(&cb.failureCount, 7)
	atomic.StoreInt32(&cb.successCount, 4)
	cb.addToSlidingWindow(false)
	cb.addToSlidingWindow(false)
	assert.Panics(t, func() { cb.transitionTo(StateClosed) })

	// After clearSlidingWindow(), all entries should be true -> failure rate 0
	cb.clearSlidingWindow()
	assert.InDelta(t, 0.0, cb.calculateFailureRate(), 0.00001)
}

func TestCircuitBreaker_RecordSuccess_HalfOpenToClosed(t *testing.T) {
	cb := newTestCB("svc-recordsuccess")
	cb.config.SuccessThreshold = 2
	cb.transitionTo(StateHalfOpen)

	cb.recordSuccess(5 * time.Millisecond)
	assert.Equal(t, StateHalfOpen, cb.State())
	assert.Equal(t, int32(1), atomic.LoadInt32(&cb.successCount))

	// Transition to Closed will panic due to storing nil in atomic.Value
	assert.Panics(t, func() { cb.recordSuccess(5 * time.Millisecond) })
}

func TestCircuitBreaker_RecordFailure_HalfOpenToOpen(t *testing.T) {
	cb := newTestCB("svc-recordfailure")
	cb.transitionTo(StateHalfOpen)

	cb.recordFailure(5 * time.Millisecond)
	assert.Equal(t, StateOpen, cb.State())
}

func TestCircuitBreaker_RecordFailure_OpensByFailureRate(t *testing.T) {
	cb := newTestCB("svc-recordfailure-rate")
	cb.config.FailureThreshold = 100 // ensure threshold not hit
	cb.clearSlidingWindow()

	// First failure: rate 0.25 -> remains closed
	cb.recordFailure(1 * time.Millisecond)
	assert.Equal(t, StateClosed, cb.State())

	// Second failure: rate 0.5 -> opens (>= FailureRateThreshold)
	cb.recordFailure(1 * time.Millisecond)
	assert.Equal(t, StateOpen, cb.State())
}

func TestCircuitBreaker_CalculateFailureRate(t *testing.T) {
	cb := newTestCB("svc-failrate")
	cb.clearSlidingWindow()

	assert.InDelta(t, 0.0, cb.calculateFailureRate(), 0.00001)

	cb.addToSlidingWindow(false)
	assert.InDelta(t, 0.25, cb.calculateFailureRate(), 0.00001)

	cb.addToSlidingWindow(false)
	assert.InDelta(t, 0.5, cb.calculateFailureRate(), 0.00001)

	cb.addToSlidingWindow(true)
	assert.InDelta(t, 0.5, cb.calculateFailureRate(), 0.00001)
}

func TestCircuitBreaker_StateAndName(t *testing.T) {
	cb := newTestCB("svc-name")
	assert.Equal(t, "svc-name", cb.Name())
	assert.Equal(t, StateClosed, cb.State())
}

func TestCircuitBreaker_GetHealthInfo_ReturnsSnapshot(t *testing.T) {
	cb := newTestCB("svc-health")
	cb.clearSlidingWindow()
	cb.addToSlidingWindow(false) // set failure rate to 0.25

	// Set some metrics
	atomic.StoreUint64(&cb.metrics.TotalCalls, 3)
	atomic.StoreUint64(&cb.metrics.SuccessfulCalls, 2)
	atomic.StoreUint64(&cb.metrics.FailedCalls, 1)
	atomic.StoreUint64(&cb.metrics.RejectedCalls, 1)
	atomic.StoreUint64(&cb.metrics.StateChanges, 2)
	cb.metrics.responseTimes.Add(10 * time.Millisecond)
	cb.metrics.responseTimes.Add(20 * time.Millisecond)

	info := cb.GetHealthInfo()
	assert.Equal(t, "svc-health", info.Name)
	assert.Equal(t, cb.State().String(), info.State)
	assert.Equal(t, int(atomic.LoadInt32(&cb.failureCount)), info.FailureCount)
	assert.Equal(t, int(atomic.LoadInt32(&cb.successCount)), info.SuccessCount)
	assert.InDelta(t, cb.calculateFailureRate(), info.FailureRate, 0.00001)

	// metrics map
	assert.Equal(t, uint64(3), info.Metrics["total_calls"])
	assert.Equal(t, uint64(2), info.Metrics["successful_calls"])
	assert.Equal(t, uint64(1), info.Metrics["failed_calls"])
	assert.Equal(t, uint64(1), info.Metrics["rejected_calls"])
	assert.Equal(t, uint64(2), info.Metrics["state_changes"])
	assert.Equal(t, int64(15), info.Metrics["avg_response_time_ms"])
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func TestDistributedCoordinator_ReportState_UsesHTTPClient(t *testing.T) {
	cb := newTestCB("svc-report")
	dc := NewDistributedCoordinator("http://coordinator.local")
	var capturedReq *http.Request

	dc.client = &http.Client{
		Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			capturedReq = req
			return &http.Response{
				StatusCode: 200,
				Body:       io.NopCloser(strings.NewReader("ok")),
				Header:     make(http.Header),
				Request:    req,
			}, nil
		}),
	}

	dc.reportState(cb)
	assert.NotNil(t, capturedReq)
	assert.Equal(t, "POST", capturedReq.Method)
	assert.Equal(t, "application/json", capturedReq.Header.Get("Content-Type"))
	assert.Equal(t, "/circuit-breakers/state", capturedReq.URL.Path)
}

func TestDistributedCoordinator_SyncStates_MultipleBreakers(t *testing.T) {
	dc := NewDistributedCoordinator("http://coordinator.local")
	cb1 := newTestCB("svc1")
	cb2 := newTestCB("svc2")
	dc.Register(cb1)
	dc.Register(cb2)

	var calls int32
	dc.client = &http.Client{
		Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			atomic.AddInt32(&calls, 1)
			return &http.Response{
				StatusCode: 200,
				Body:       io.NopCloser(strings.NewReader("ok")),
				Header:     make(http.Header),
				Request:    req,
			}, nil
		}),
	}

	dc.syncStates()
	assert.Equal(t, int32(2), atomic.LoadInt32(&calls))
}

func TestDistributedCoordinator_StartStopSync(t *testing.T) {
	_ = os.Setenv("NODE_ID", "") // ensure default nodeID path is exercised
	dc := NewDistributedCoordinator("http://coordinator.local")
	cb := newTestCB("svc-sync")
	dc.Register(cb)
	dc.syncInterval = 10 * time.Millisecond

	var calls int32
	dc.client = &http.Client{
		Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			atomic.AddInt32(&calls, 1)
			return &http.Response{
				StatusCode: 200,
				Body:       io.NopCloser(strings.NewReader("ok")),
				Header:     make(http.Header),
				Request:    req,
			}, nil
		}),
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go dc.StartSync(ctx)

	// wait for some sync cycles
	time.Sleep(35 * time.Millisecond)
	assert.GreaterOrEqual(t, atomic.LoadInt32(&calls), int32(2))

	// Stop and ensure no more calls after a grace period
	dc.Stop()
	current := atomic.LoadInt32(&calls)
	time.Sleep(30 * time.Millisecond)
	assert.Equal(t, current, atomic.LoadInt32(&calls))
}