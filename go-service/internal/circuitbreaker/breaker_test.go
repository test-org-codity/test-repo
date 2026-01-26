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
	var unknown State = 999
	assert.Equal(t, "UNKNOWN", unknown.String())
}

func TestRingBuffer_AddAndAverage(t *testing.T) {
	rb := NewRingBuffer(3)
	assert.NotNil(t, rb)
	assert.Equal(t, time.Duration(0), rb.Average())

	rb.Add(10 * time.Millisecond)
	rb.Add(20 * time.Millisecond)
	assert.Equal(t, 15*time.Millisecond, rb.Average())

	rb.Add(30 * time.Millisecond)
	assert.Equal(t, 20*time.Millisecond, rb.Average())

	rb.Add(60 * time.Millisecond)
	// Average of last 3: (20 + 30 + 60) / 3 = 110/3ms = 36ms (truncated)
	assert.Equal(t, 36*time.Millisecond, rb.Average())
}

func TestCircuitBreaker_Execute_Success(t *testing.T) {
	cfg := DefaultConfig()
	cfg.FailureRateThreshold = 2.0 // disable rate-based opening for test predictability
	cb := New("success", cfg)
	assert.NotNil(t, cb)

	err := cb.Execute(context.Background(), func() error {
		return nil
	})
	assert.NoError(t, err)
	assert.Equal(t, StateClosed, cb.State())

	hi := cb.GetHealthInfo()
	assert.Equal(t, "success", hi.Name)
	assert.Equal(t, "CLOSED", hi.State)
	assert.Equal(t, uint64(1), hi.Metrics["total_calls"])
	assert.Equal(t, uint64(1), hi.Metrics["successful_calls"])
	assert.Equal(t, uint64(0), hi.Metrics["failed_calls"])
}

func TestCircuitBreaker_OpenOnFailureThreshold(t *testing.T) {
	cfg := DefaultConfig()
	cfg.FailureThreshold = 3
	cfg.Timeout = 20 * time.Millisecond
	cfg.FailureRateThreshold = 2.0 // disable rate-based to rely on count threshold
	cfg.SlidingWindowSize = 10
	cb := New("open-threshold", cfg)

	for i := 0; i < 3; i++ {
		err := cb.Execute(context.Background(), func() error {
			return errors.New("fail")
		})
		assert.Error(t, err)
	}
	assert.Equal(t, StateOpen, cb.State())

	// Next call should be rejected immediately
	err := cb.Execute(context.Background(), func() error {
		return nil
	})
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "is open")
	assert.Equal(t, uint64(1), cb.metrics.RejectedCalls)
}

func TestCircuitBreaker_HalfOpenAllowsLimitedCalls(t *testing.T) {
	cfg := DefaultConfig()
	cfg.FailureThreshold = 1
	cfg.Timeout = 5 * time.Millisecond
	cfg.HalfOpenMaxCalls = 2
	cfg.SuccessThreshold = 10 // keep in half-open after two successes
	cfg.FailureRateThreshold = 2.0
	cb := New("half-open-limit", cfg)

	// Open the breaker
	_ = cb.Execute(context.Background(), func() error { return errors.New("boom") })
	assert.Equal(t, StateOpen, cb.State())

	// Wait for timeout to allow reset to half-open
	time.Sleep(cfg.Timeout + 5*time.Millisecond)

	var wg sync.WaitGroup
	totalCalls := 5
	startedCh := make(chan struct{}, totalCalls)
	releaseCh := make(chan struct{})
	errCh := make(chan error, totalCalls)

	op := func() error {
		startedCh <- struct{}{}
		<-releaseCh
		return nil
	}

	for i := 0; i < totalCalls; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errCh <- cb.Execute(context.Background(), op)
		}()
	}

	// Give goroutines time to attempt
	time.Sleep(20 * time.Millisecond)
	close(releaseCh)
	wg.Wait()
	close(errCh)

	started := len(startedCh)
	rejected := 0
	for e := range errCh {
		if e != nil && e.Error() != "" {
			rejected++
		}
	}

	assert.Equal(t, StateHalfOpen, cb.State())
	assert.Equal(t, cfg.HalfOpenMaxCalls, started)
	assert.Equal(t, totalCalls-cfg.HalfOpenMaxCalls, rejected)
}

func TestCircuitBreaker_HalfOpenSuccessCloses(t *testing.T) {
	cfg := DefaultConfig()
	cfg.FailureThreshold = 1
	cfg.Timeout = 5 * time.Millisecond
	cfg.HalfOpenMaxCalls = 3
	cfg.SuccessThreshold = 2
	cfg.FailureRateThreshold = 2.0
	cb := New("half-open-close", cfg)

	// Open breaker
	_ = cb.Execute(context.Background(), func() error { return errors.New("boom") })
	assert.Equal(t, StateOpen, cb.State())

	time.Sleep(cfg.Timeout + 5*time.Millisecond)

	// Two successful probes should close
	assert.NoError(t, cb.Execute(context.Background(), func() error { return nil }))
	assert.Equal(t, StateHalfOpen, cb.State())
	assert.NoError(t, cb.Execute(context.Background(), func() error { return nil }))
	assert.Equal(t, StateClosed, cb.State())
}

func TestCircuitBreaker_HalfOpenFailureReopens(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Timeout = 0
	cfg.HalfOpenMaxCalls = 1
	cfg.SuccessThreshold = 1
	cfg.FailureThreshold = 10
	cfg.FailureRateThreshold = 2.0
	cb := New("half-open-reopen", cfg)

	// Force open and immediate reset availability
	cb.transitionTo(StateOpen)
	assert.Equal(t, StateOpen, cb.State())

	err := cb.Execute(context.Background(), func() error { return errors.New("fail") })
	assert.Error(t, err)
	assert.Equal(t, StateOpen, cb.State())
}

func TestCircuitBreaker_ExecuteWithFallback(t *testing.T) {
	cfg := DefaultConfig()
	cfg.FailureRateThreshold = 2.0
	cb := New("with-fallback", cfg)

	// Operation fails, fallback succeeds
	err := cb.ExecuteWithFallback(context.Background(),
		func() error { return errors.New("op-fail") },
		func() error { return nil },
	)
	assert.NoError(t, err)

	hi := cb.GetHealthInfo()
	assert.Equal(t, uint64(1), hi.Metrics["total_calls"])
	assert.Equal(t, uint64(1), hi.Metrics["failed_calls"])
}

func TestCircuitBreaker_GetHealthInfo(t *testing.T) {
	cfg := DefaultConfig()
	cfg.SlidingWindowSize = 4
	cfg.FailureRateThreshold = 2.0
	cb := New("health", cfg)
	// Ensure a clean sliding window (all true)
	cb.clearSlidingWindow()

	// One success and one failure
	_ = cb.Execute(context.Background(), func() error { return nil })
	_ = cb.Execute(context.Background(), func() error { return errors.New("x") })

	hi := cb.GetHealthInfo()
	assert.Equal(t, "health", hi.Name)
	assert.Equal(t, "CLOSED", hi.State)
	assert.GreaterOrEqual(t, hi.FailureRate, 0.0)
	assert.LessOrEqual(t, hi.FailureRate, 1.0)

	metrics := hi.Metrics
	assert.NotNil(t, metrics)
	_, ok := metrics["total_calls"]
	assert.True(t, ok)
	_, ok = metrics["successful_calls"]
	assert.True(t, ok)
	_, ok = metrics["failed_calls"]
	assert.True(t, ok)
	_, ok = metrics["rejected_calls"]
	assert.True(t, ok)
	_, ok = metrics["state_changes"]
	assert.True(t, ok)
	_, ok = metrics["avg_response_time_ms"]
	assert.True(t, ok)
}

func TestGetOrCreate_ReturnsSameInstance(t *testing.T) {
	cfg := DefaultConfig()
	name := "singleton"
	cb1 := GetOrCreate(name, cfg)
	cb2 := GetOrCreate(name, cfg)
	assert.Same(t, cb1, cb2)
}

func TestDistributedCoordinator_RegisterAndSyncStates(t *testing.T) {
	var hitCount int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/circuit-breakers/state" && r.Method == http.MethodPost {
			atomic.AddInt64(&hitCount, 1)
			w.WriteHeader(http.StatusOK)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	dc := NewDistributedCoordinator(srv.URL)
	dc.client = srv.Client()

	cfg := DefaultConfig()
	cfg.FailureRateThreshold = 2.0
	cbA := New("service-A", cfg)
	cbB := New("service-B", cfg)

	dc.Register(cbA)
	dc.Register(cbB)

	dc.syncStates()
	assert.Equal(t, int64(2), atomic.LoadInt64(&hitCount))
}

func TestDistributedCoordinator_StartSyncAndStop(t *testing.T) {
	var hits int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/circuit-breakers/state" && r.Method == http.MethodPost {
			atomic.AddInt64(&hits, 1)
			w.WriteHeader(http.StatusOK)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	dc := NewDistributedCoordinator(srv.URL)
	dc.client = srv.Client()
	dc.syncInterval = 10 * time.Millisecond

	cfg := DefaultConfig()
	cfg.FailureRateThreshold = 2.0
	cb := New("sync-service", cfg)
	dc.Register(cb)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go dc.StartSync(ctx)
	// Allow some sync cycles
	time.Sleep(35 * time.Millisecond)
	dc.Stop()
	prevHits := atomic.LoadInt64(&hits)

	// Wait to ensure no more hits after stop
	time.Sleep(30 * time.Millisecond)
	afterHits := atomic.LoadInt64(&hits)

	assert.GreaterOrEqual(t, prevHits, int64(1))
	assert.Equal(t, prevHits, afterHits)
}
