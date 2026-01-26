package circuitbreaker

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
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
		{name: "closed", s: StateClosed, want: "CLOSED"},
		{name: "open", s: StateOpen, want: "OPEN"},
		{name: "half_open", s: StateHalfOpen, want: "HALF_OPEN"},
		{name: "unknown", s: State(999), want: "UNKNOWN"},
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

func TestRingBuffer_AddAndAverage(t *testing.T) {
	t.Run("average empty is zero", func(t *testing.T) {
		rb := NewRingBuffer(3)
		assert.Equal(t, time.Duration(0), rb.Average())
	})

	t.Run("average with less than size", func(t *testing.T) {
		rb := NewRingBuffer(3)
		rb.Add(10 * time.Millisecond)
		rb.Add(20 * time.Millisecond)
		assert.Equal(t, 15*time.Millisecond, rb.Average())
	})

	t.Run("average with wrap uses first count entries (current implementation)", func(t *testing.T) {
		rb := NewRingBuffer(3)
		rb.Add(10 * time.Millisecond)
		rb.Add(20 * time.Millisecond)
		rb.Add(30 * time.Millisecond)
		assert.Equal(t, 20*time.Millisecond, rb.Average())

		rb.Add(40 * time.Millisecond)

		// Note: Average iterates data[0:count], which after wrap is [40,20,30]
		// and equals 30ms.
		assert.Equal(t, 30*time.Millisecond, rb.Average())
	})

	t.Run("concurrent add and average does not race/panic", func(t *testing.T) {
		rb := NewRingBuffer(10)
		var wg sync.WaitGroup
		stop := make(chan struct{})

		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
					rb.Add(1 * time.Millisecond)
				}
			}
		}()

		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < 1000; i++ {
				_ = rb.Average()
			}
			close(stop)
		}()

		wg.Wait()
		assert.GreaterOrEqual(t, rb.Average(), time.Duration(0))
	})
}

func TestNewAndGetOrCreate(t *testing.T) {
	registryMu.Lock()
	registry = make(map[string]*CircuitBreaker)
	registryMu.Unlock()

	cfg := DefaultConfig()
	cfg.SlidingWindowSize = 7

	cb := New("svcA", cfg)
	assert.NotNil(t, cb)
	assert.Equal(t, "svcA", cb.Name())
	assert.Equal(t, StateClosed, cb.State())
	assert.NotNil(t, cb.metrics)
	assert.NotNil(t, cb.metrics.responseTimes)
	assert.Len(t, cb.slidingWindow, cfg.SlidingWindowSize)

	cb1 := GetOrCreate("svcB", cfg)
	cb2 := GetOrCreate("svcB", DefaultConfig())
	assert.Same(t, cb1, cb2)
	assert.Equal(t, "svcB", cb1.Name())
}

func TestCircuitBreaker_Execute_SuccessAndFailureMetrics(t *testing.T) {
	cfg := DefaultConfig()
	cfg.FailureThreshold = 100
	cfg.FailureRateThreshold = 1.0
	cfg.SlidingWindowSize = 5

	cb := New("svc", cfg)

	err := cb.Execute(context.Background(), func() error { return nil })
	assert.NoError(t, err)
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.TotalCalls))
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.SuccessfulCalls))
	assert.Equal(t, uint64(0), atomic.LoadUint64(&cb.metrics.FailedCalls))
	assert.WithinDuration(t, time.Now(), cb.metrics.LastSuccess, 2*time.Second)
	assert.Equal(t, StateClosed, cb.State())

	err = cb.Execute(context.Background(), func() error { return assert.AnError })
	assert.ErrorIs(t, err, assert.AnError)
	assert.Equal(t, uint64(2), atomic.LoadUint64(&cb.metrics.TotalCalls))
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.SuccessfulCalls))
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.FailedCalls))
	assert.WithinDuration(t, time.Now(), cb.metrics.LastFailure, 2*time.Second)
}

func TestCircuitBreaker_ExecuteWithFallback(t *testing.T) {
	cfg := DefaultConfig()
	cfg.FailureThreshold = 100
	cfg.FailureRateThreshold = 1.0
	cfg.SlidingWindowSize = 3
	cb := New("svc", cfg)

	t.Run("no error does not call fallback", func(t *testing.T) {
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

	t.Run("error calls fallback when provided", func(t *testing.T) {
		called := int32(0)
		err := cb.ExecuteWithFallback(context.Background(),
			func() error { return assert.AnError },
			func() error {
				atomic.AddInt32(&called, 1)
				return nil
			},
		)
		assert.NoError(t, err)
		assert.Equal(t, int32(1), atomic.LoadInt32(&called))
	})

	t.Run("error no fallback returns original error", func(t *testing.T) {
		err := cb.ExecuteWithFallback(context.Background(),
			func() error { return assert.AnError },
			nil,
		)
		assert.ErrorIs(t, err, assert.AnError)
	})
}

func TestCircuitBreaker_Transitions_FailureThreshold(t *testing.T) {
	cfg := DefaultConfig()
	cfg.FailureThreshold = 2
	cfg.FailureRateThreshold = 1.0
	cfg.Timeout = 50 * time.Millisecond
	cfg.SlidingWindowSize = 4
	cfg.HalfOpenMaxCalls = 1
	cfg.SuccessThreshold = 1

	cb := New("svc", cfg)

	var changesMu sync.Mutex
	var changes []string
	cb.onStateChange = func(name string, from, to State) {
		changesMu.Lock()
		defer changesMu.Unlock()
		changes = append(changes, name+":"+from.String()+"->"+to.String())
	}

	_ = cb.Execute(context.Background(), func() error { return assert.AnError })
	assert.Equal(t, StateClosed, cb.State())

	_ = cb.Execute(context.Background(), func() error { return assert.AnError })
	assert.Equal(t, StateOpen, cb.State())

	changesMu.Lock()
	assert.Len(t, changes, 1)
	assert.True(t, strings.Contains(changes[0], "CLOSED->OPEN"))
	changesMu.Unlock()

	err := cb.Execute(context.Background(), func() error { return nil })
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "circuit breaker 'svc' is open")
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.RejectedCalls))

	time.Sleep(cfg.Timeout + 10*time.Millisecond)

	err = cb.Execute(context.Background(), func() error { return nil })
	assert.NoError(t, err)
	assert.Equal(t, StateClosed, cb.State())
	assert.GreaterOrEqual(t, atomic.LoadUint64(&cb.metrics.StateChanges), uint64(3)) // OPEN + HALF_OPEN + CLOSED
}

func TestCircuitBreaker_FailureRateThresholdOpens(t *testing.T) {
	cfg := DefaultConfig()
	cfg.FailureThreshold = 1000
	cfg.FailureRateThreshold = 0.5
	cfg.SlidingWindowSize = 4

	cb := New("svc", cfg)

	_ = cb.Execute(context.Background(), func() error { return assert.AnError })
	assert.Equal(t, StateClosed, cb.State())

	_ = cb.Execute(context.Background(), func() error { return assert.AnError })
	assert.Equal(t, StateOpen, cb.State())
}

func TestCircuitBreaker_HalfOpen_MaxCallsAndFailureReopens(t *testing.T) {
	cfg := DefaultConfig()
	cfg.FailureThreshold = 1
	cfg.FailureRateThreshold = 1.0
	cfg.Timeout = 20 * time.Millisecond
	cfg.SlidingWindowSize = 2
	cfg.HalfOpenMaxCalls = 2
	cfg.SuccessThreshold = 2

	cb := New("svc", cfg)

	_ = cb.Execute(context.Background(), func() error { return assert.AnError })
	assert.Equal(t, StateOpen, cb.State())

	time.Sleep(cfg.Timeout + 5*time.Millisecond)

	err1 := cb.Execute(context.Background(), func() error { return nil })
	assert.NoError(t, err1)
	assert.Equal(t, StateHalfOpen, cb.State())

	err2 := cb.Execute(context.Background(), func() error { return nil })
	assert.NoError(t, err2)

	err3 := cb.Execute(context.Background(), func() error { return nil })
	assert.Error(t, err3)
	assert.Contains(t, err3.Error(), "is open")
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.RejectedCalls))

	_ = cb.Execute(context.Background(), func() error { return assert.AnError })
	assert.Equal(t, StateOpen, cb.State())
}

func TestCircuitBreaker_recordSuccess_DecrementsFailureCountWhenClosed(t *testing.T) {
	cfg := DefaultConfig()
	cfg.FailureThreshold = 100
	cfg.FailureRateThreshold = 1.0
	cfg.SlidingWindowSize = 5
	cb := New("svc", cfg)

	atomic.StoreInt32(&cb.failureCount, 2)
	cb.recordSuccess(1 * time.Millisecond)

	assert.Equal(t, int32(1), atomic.LoadInt32(&cb.failureCount))
	cb.recordSuccess(1 * time.Millisecond)
	assert.Equal(t, int32(0), atomic.LoadInt32(&cb.failureCount))
	cb.recordSuccess(1 * time.Millisecond)
	assert.Equal(t, int32(0), atomic.LoadInt32(&cb.failureCount))
}

func TestCircuitBreaker_GetHealthInfo(t *testing.T) {
	cfg := DefaultConfig()
	cfg.FailureThreshold = 100
	cfg.FailureRateThreshold = 1.0
	cfg.SlidingWindowSize = 4

	cb := New("svc", cfg)

	_ = cb.Execute(context.Background(), func() error { return nil })
	_ = cb.Execute(context.Background(), func() error { return assert.AnError })

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

	assert.Equal(t, float64(atomic.LoadUint64(&cb.metrics.TotalCalls)), hi.Metrics["total_calls"])
	assert.Equal(t, float64(atomic.LoadUint64(&cb.metrics.SuccessfulCalls)), hi.Metrics["successful_calls"])
	assert.Equal(t, float64(atomic.LoadUint64(&cb.metrics.FailedCalls)), hi.Metrics["failed_calls"])
	assert.Equal(t, float64(atomic.LoadUint64(&cb.metrics.RejectedCalls)), hi.Metrics["rejected_calls"])
	assert.Equal(t, float64(atomic.LoadUint64(&cb.metrics.StateChanges)), hi.Metrics["state_changes"])
}

func TestDistributedCoordinator_RegisterAndSync_ReportState(t *testing.T) {
	var gotPath string
	var gotMethod string
	var gotContentType string

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotMethod = r.Method
		gotContentType = r.Header.Get("Content-Type")
		_, _ = io.Copy(io.Discard, r.Body)
		_ = r.Body.Close()
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	dc := NewDistributedCoordinator(srv.URL)
	dc.syncInterval = 5 * time.Millisecond

	cfg := DefaultConfig()
	cfg.SlidingWindowSize = 3
	cb := New("svc", cfg)

	dc.Register(cb)

	dc.syncStates()

	assert.Equal(t, "/circuit-breakers/state", gotPath)
	assert.Equal(t, "POST", gotMethod)
	assert.Equal(t, "application/json", gotContentType)
}

func TestDistributedCoordinator_StartSync_Stop(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	dc := NewDistributedCoordinator(srv.URL)
	dc.syncInterval = 10 * time.Millisecond

	cb := New("svc", DefaultConfig())
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
	case <-time.After(200 * time.Millisecond):
		assert.Fail(t, "StartSync did not stop in time")
	}

	assert.GreaterOrEqual(t, hits.Load(), int32(1))
}

func TestDistributedCoordinator_reportState_DoesNotPanicWithNilOpenedAtAndUsesClient(t *testing.T) {
	var reqCount atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reqCount.Add(1)
		body, _ := io.ReadAll(r.Body)
		_ = r.Body.Close()
		assert.Equal(t, 0, len(bytes.TrimSpace(body)), "request body is expected to be empty per current implementation")
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	dc := NewDistributedCoordinator(srv.URL)
	cb := New("svc", DefaultConfig())

	assert.NotPanics(t, func() { dc.reportState(cb) })
	assert.Equal(t, int32(1), reqCount.Load())
}
