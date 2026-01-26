package circuitbreaker

import (
	"context"
	"net/http"
	"os"
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
	assert.Equal(t, 0.5, cfg.FailureRateThreshold)
}

func TestNewRingBuffer_AddAndAverage(t *testing.T) {
	rb := NewRingBuffer(3)
	assert.Equal(t, time.Duration(0), rb.Average())

	rb.Add(10 * time.Millisecond)
	assert.Equal(t, 10*time.Millisecond, rb.Average())

	rb.Add(20 * time.Millisecond)
	rb.Add(30 * time.Millisecond)
	assert.Equal(t, 20*time.Millisecond, rb.Average())

	// Overwrite oldest
	rb.Add(40 * time.Millisecond)
	// Buffer has [40,20,30] or [20,30,40] depending on head; but all 3 included
	avg := rb.Average()
	assert.True(t, avg >= 30*time.Millisecond && avg <= 40*time.Millisecond)
}

func TestNewCircuitBreakerDefaults(t *testing.T) {
	cfg := DefaultConfig()
	cb := New("test", cfg)
	assert.Equal(t, "test", cb.Name())
	assert.Equal(t, StateClosed, cb.State())
	assert.Len(t, cb.slidingWindow, cfg.SlidingWindowSize)
	assert.NotNil(t, cb.metrics)
	assert.NotNil(t, cb.metrics.responseTimes)
}

func TestGetOrCreate(t *testing.T) {
	registryMu.Lock()
	registry = make(map[string]*CircuitBreaker)
	registryMu.Unlock()

	cfg := DefaultConfig()
	cb1 := GetOrCreate("svc", cfg)
	cb2 := GetOrCreate("svc", cfg)

	assert.Same(t, cb1, cb2)
}

func TestCircuitBreaker_Execute_Success(t *testing.T) {
	cfg := DefaultConfig()
	cb := New("exec-success", cfg)

	err := cb.Execute(context.Background(), func() error {
		time.Sleep(1 * time.Millisecond)
		return nil
	})

	assert.NoError(t, err)
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.TotalCalls))
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.SuccessfulCalls))
	assert.Equal(t, StateClosed, cb.State())
}

func TestCircuitBreaker_Execute_Failure_ThresholdTripsOpen(t *testing.T) {
	cfg := DefaultConfig()
	cfg.FailureThreshold = 2
	cfg.SlidingWindowSize = 2
	cfg.FailureRateThreshold = 1.0
	cb := New("exec-fail", cfg)

	opErr := assert.AnError

	for i := 0; i < 2; i++ {
		err := cb.Execute(context.Background(), func() error {
			return opErr
		})
		assert.Error(t, err)
	}

	assert.Equal(t, uint64(2), atomic.LoadUint64(&cb.metrics.FailedCalls))
	assert.Equal(t, StateOpen, cb.State())
}

func TestCircuitBreaker_Execute_RejectedWhenOpen(t *testing.T) {
	cfg := DefaultConfig()
	cfg.FailureThreshold = 1
	cfg.Timeout = time.Hour
	cb := New("exec-open", cfg)

	_ = cb.Execute(context.Background(), func() error {
		return assert.AnError
	})

	assert.Equal(t, StateOpen, cb.State())

	err := cb.Execute(context.Background(), func() error {
		return nil
	})
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "circuit breaker 'exec-open' is open")
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.RejectedCalls))
}

func TestCircuitBreaker_ExecuteWithFallback(t *testing.T) {
	cfg := DefaultConfig()
	cfg.FailureThreshold = 1
	cb := New("exec-fallback", cfg)

	var fallbackCalled bool

	// operation fails, fallback called
	err := cb.ExecuteWithFallback(context.Background(), func() error {
		return assert.AnError
	}, func() error {
		fallbackCalled = true
		return nil
	})
	assert.NoError(t, err)
	assert.True(t, fallbackCalled)

	// operation succeeds, fallback not called
	fallbackCalled = false
	err = cb.ExecuteWithFallback(context.Background(), func() error {
		return nil
	}, func() error {
		fallbackCalled = true
		return nil
	})
	assert.NoError(t, err)
	assert.False(t, fallbackCalled)
}

func TestCircuitBreaker_allowRequest_Closed(t *testing.T) {
	cfg := DefaultConfig()
	cb := New("allow-closed", cfg)
	assert.True(t, cb.allowRequest())
}

func TestCircuitBreaker_allowRequest_Open_NoReset(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Timeout = time.Hour
	cb := New("allow-open-no-reset", cfg)
	cb.transitionTo(StateOpen)
	assert.False(t, cb.allowRequest())
}

func TestCircuitBreaker_allowRequest_Open_WithResetToHalfOpen(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Timeout = 0
	cfg.HalfOpenMaxCalls = 2
	cb := New("allow-open-reset", cfg)
	cb.transitionTo(StateOpen)

	assert.True(t, cb.allowRequest())
	assert.Equal(t, StateHalfOpen, cb.State())

	assert.True(t, cb.allowRequest())
	assert.False(t, cb.allowRequest())
}

func TestCircuitBreaker_shouldAttemptReset(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Timeout = 10 * time.Millisecond
	cb := New("reset", cfg)

	assert.False(t, cb.shouldAttemptReset())

	cb.transitionTo(StateOpen)
	assert.False(t, cb.shouldAttemptReset())

	time.Sleep(15 * time.Millisecond)
	assert.True(t, cb.shouldAttemptReset())
}

func TestCircuitBreaker_transitionTo_Idempotent(t *testing.T) {
	cfg := DefaultConfig()
	cb := New("transition-idem", cfg)

	cb.transitionTo(StateClosed)
	assert.Equal(t, StateClosed, cb.State())
}

func TestCircuitBreaker_transitionTo_StateChangesAndMetrics(t *testing.T) {
	cfg := DefaultConfig()
	cb := New("transition", cfg)

	var fromState, toState State
	cb.onStateChange = func(name string, from, to State) {
		fromState = from
		toState = to
	}

	cb.transitionTo(StateOpen)
	assert.Equal(t, StateOpen, cb.State())
	assert.Equal(t, StateClosed, fromState)
	assert.Equal(t, StateOpen, toState)
	assert.NotNil(t, cb.openedAt.Load())
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.StateChanges))

	cb.transitionTo(StateHalfOpen)
	assert.Equal(t, StateHalfOpen, cb.State())
	assert.Equal(t, int32(0), atomic.LoadInt32(&cb.halfOpenCalls))
	assert.Equal(t, int32(0), atomic.LoadInt32(&cb.successCount))

	cb.transitionTo(StateClosed)
	assert.Equal(t, StateClosed, cb.State())
	assert.Equal(t, int32(0), atomic.LoadInt32(&cb.failureCount))
	assert.Equal(t, int32(0), atomic.LoadInt32(&cb.successCount))
	assert.Nil(t, cb.openedAt.Load())
}

func TestCircuitBreaker_recordSuccess_FromHalfOpenToClosed(t *testing.T) {
	cfg := DefaultConfig()
	cfg.SuccessThreshold = 2
	cb := New("success-half-open", cfg)
	cb.transitionTo(StateHalfOpen)

	cb.recordSuccess(5 * time.Millisecond)
	assert.Equal(t, StateHalfOpen, cb.State())

	cb.recordSuccess(5 * time.Millisecond)
	assert.Equal(t, StateClosed, cb.State())
}

func TestCircuitBreaker_recordSuccess_DecrementsFailureCountInClosed(t *testing.T) {
	cfg := DefaultConfig()
	cb := New("success-closed", cfg)

	atomic.StoreInt32(&cb.failureCount, 2)
	cb.recordSuccess(5 * time.Millisecond)
	assert.Equal(t, int32(1), atomic.LoadInt32(&cb.failureCount))

	cb.recordSuccess(5 * time.Millisecond)
	assert.Equal(t, int32(0), atomic.LoadInt32(&cb.failureCount))
}

func TestCircuitBreaker_recordFailure_FromHalfOpenToOpen(t *testing.T) {
	cfg := DefaultConfig()
	cb := New("failure-half-open", cfg)
	cb.transitionTo(StateHalfOpen)

	cb.recordFailure(5 * time.Millisecond)
	assert.Equal(t, StateOpen, cb.State())
}

func TestCircuitBreaker_recordFailure_ThresholdOrRateTripsOpen(t *testing.T) {
	cfg := DefaultConfig()
	cfg.FailureThreshold = 3
	cfg.SlidingWindowSize = 4
	cfg.FailureRateThreshold = 0.5
	cb := New("failure-closed", cfg)

	cb.recordFailure(1 * time.Millisecond)
	assert.Equal(t, StateClosed, cb.State())

	cb.recordFailure(1 * time.Millisecond)
	cb.recordFailure(1 * time.Millisecond)
	assert.Equal(t, StateOpen, cb.State())
}

func TestCircuitBreaker_addToSlidingWindowAndFailureRate(t *testing.T) {
	cfg := DefaultConfig()
	cfg.SlidingWindowSize = 4
	cb := New("window", cfg)

	cb.clearSlidingWindow()
	cb.addToSlidingWindow(true)
	cb.addToSlidingWindow(false)
	cb.addToSlidingWindow(false)
	cb.addToSlidingWindow(true)

	rate := cb.calculateFailureRate()
	assert.InDelta(t, 0.5, rate, 0.001)
}

func TestCircuitBreaker_clearSlidingWindow(t *testing.T) {
	cfg := DefaultConfig()
	cfg.SlidingWindowSize = 3
	cb := New("clear-window", cfg)

	cb.addToSlidingWindow(false)
	cb.addToSlidingWindow(false)
	cb.addToSlidingWindow(false)

	cb.clearSlidingWindow()
	rate := cb.calculateFailureRate()
	assert.Equal(t, 0.0, rate)
}

func TestCircuitBreaker_StateAndName(t *testing.T) {
	cfg := DefaultConfig()
	cb := New("name-test", cfg)
	assert.Equal(t, "name-test", cb.Name())
	assert.Equal(t, StateClosed, cb.State())

	cb.transitionTo(StateOpen)
	assert.Equal(t, StateOpen, cb.State())
}

func TestCircuitBreaker_GetHealthInfo(t *testing.T) {
	cfg := DefaultConfig()
	cfg.SlidingWindowSize = 2
	cb := New("health", cfg)

	cb.clearSlidingWindow()
	cb.recordFailure(10 * time.Millisecond)
	cb.recordSuccess(20 * time.Millisecond)

	hi := cb.GetHealthInfo()
	assert.Equal(t, "health", hi.Name)
	assert.Equal(t, cb.State().String(), hi.State)
	assert.Equal(t, int(atomic.LoadInt32(&cb.failureCount)), hi.FailureCount)
	assert.Equal(t, int(atomic.LoadInt32(&cb.successCount)), hi.SuccessCount)
	assert.InDelta(t, cb.calculateFailureRate(), hi.FailureRate, 0.0001)

	assert.Equal(t, atomic.LoadUint64(&cb.metrics.TotalCalls), hi.Metrics["total_calls"])
	assert.Equal(t, atomic.LoadUint64(&cb.metrics.SuccessfulCalls), hi.Metrics["successful_calls"])
	assert.Equal(t, atomic.LoadUint64(&cb.metrics.FailedCalls), hi.Metrics["failed_calls"])
	assert.Equal(t, atomic.LoadUint64(&cb.metrics.RejectedCalls), hi.Metrics["rejected_calls"])
	assert.Equal(t, atomic.LoadUint64(&cb.metrics.StateChanges), hi.Metrics["state_changes"])
	_, ok := hi.Metrics["avg_response_time_ms"]
	assert.True(t, ok)
}

func TestNewDistributedCoordinator_Defaults(t *testing.T) {
	os.Unsetenv("NODE_ID")
	dc := NewDistributedCoordinator("http://coord")
	assert.Equal(t, "http://coord", dc.coordinatorURL)
	assert.NotEmpty(t, dc.nodeID)
	assert.NotNil(t, dc.client)
	assert.Equal(t, 5*time.Second, dc.syncInterval)
}

func TestNewDistributedCoordinator_WithNodeIDEnv(t *testing.T) {
	os.Setenv("NODE_ID", "node-123")
	defer os.Unsetenv("NODE_ID")

	dc := NewDistributedCoordinator("http://coord2")
	assert.Equal(t, "node-123", dc.nodeID)
}

func TestDistributedCoordinator_Register(t *testing.T) {
	dc := NewDistributedCoordinator("http://coord")
	cb := New("svc", DefaultConfig())
	dc.Register(cb)

	dc.mu.RLock()
	defer dc.mu.RUnlock()
	assert.Same(t, cb, dc.breakers["svc"])
}

type roundTripperFunc func(req *http.Request) (*http.Response, error)

func (f roundTripperFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func TestDistributedCoordinator_reportState(t *testing.T) {
	dc := NewDistributedCoordinator("http://coord")
	cb := New("svc", DefaultConfig())

	var called bool
	var capturedReq *http.Request

	dc.client = &http.Client{
		Timeout: 1 * time.Second,
		Transport: roundTripperFunc(func(req *http.Request) (*http.Response, error) {
			called = true
			capturedReq = req
			return &http.Response{
				StatusCode: 200,
				Body:       http.NoBody,
			}, nil
		}),
	}

	dc.reportState(cb)
	assert.True(t, called)
	assert.NotNil(t, capturedReq)
	assert.Equal(t, "application/json", capturedReq.Header.Get("Content-Type"))
	assert.Equal(t, "http://coord/circuit-breakers/state", capturedReq.URL.String())
}

func TestDistributedCoordinator_syncStates(t *testing.T) {
	dc := NewDistributedCoordinator("http://coord")
	cb1 := New("svc1", DefaultConfig())
	cb2 := New("svc2", DefaultConfig())
	dc.Register(cb1)
	dc.Register(cb2)

	var count int32
	dc.client = &http.Client{
		Transport: roundTripperFunc(func(req *http.Request) (*http.Response, error) {
			atomic.AddInt32(&count, 1)
			return &http.Response{StatusCode: 200, Body: http.NoBody}, nil
		}),
	}

	dc.syncStates()
	assert.Equal(t, int32(2), atomic.LoadInt32(&count))
}

func TestDistributedCoordinator_StartSyncAndStop(t *testing.T) {
	dc := NewDistributedCoordinator("http://coord")
	cb := New("svc", DefaultConfig())
	dc.Register(cb)

	var count int32
	dc.syncInterval = 10 * time.Millisecond
	dc.client = &http.Client{
		Transport: roundTripperFunc(func(req *http.Request) (*http.Response, error) {
			atomic.AddInt32(&count, 1)
			return &http.Response{StatusCode: 200, Body: http.NoBody}, nil
		}),
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go dc.StartSync(ctx)
	time.Sleep(35 * time.Millisecond)
	dc.Stop()
	time.Sleep(20 * time.Millisecond)

	current := atomic.LoadInt32(&count)
	assert.True(t, current >= 2)
}
