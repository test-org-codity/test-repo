package circuitbreaker

import (
	"context"
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
		state   State
		wantStr string
	}{
		{StateClosed, "CLOSED"},
		{StateOpen, "OPEN"},
		{StateHalfOpen, "HALF_OPEN"},
		{State(999), "UNKNOWN"},
	}
	for _, tt := range tests {
		assert.Equal(t, tt.wantStr, tt.state.String())
	}
}

func TestRingBuffer_AddAverage(t *testing.T) {
	rb := NewRingBuffer(3)
	assert.Equal(t, time.Duration(0), rb.Average())

	rb.Add(10 * time.Millisecond)
	assert.Equal(t, 10*time.Millisecond, rb.Average())

	rb.Add(20 * time.Millisecond)
	assert.Equal(t, 15*time.Millisecond, rb.Average())

	rb.Add(30 * time.Millisecond)
	assert.Equal(t, 20*time.Millisecond, rb.Average())

	// Overwrite oldest (10ms), new values: 20,30,40 => avg 30
	rb.Add(40 * time.Millisecond)
	assert.Equal(t, 30*time.Millisecond, rb.Average())
}

func TestNewAndGetOrCreate(t *testing.T) {
	cfg := DefaultConfig()
	cb := New("test-new", cfg)
	assert.Equal(t, "test-new", cb.Name())
	assert.Equal(t, StateClosed, cb.State())
	assert.NotNil(t, cb.metrics)
	assert.Equal(t, cfg.SlidingWindowSize, len(cb.slidingWindow))

	// GetOrCreate should return same instance for the same name
	name := "registry-same"
	cb1 := GetOrCreate(name, cfg)
	cb2 := GetOrCreate(name, cfg)
	assert.Same(t, cb1, cb2)

	// Different name should create new instance
	cb3 := GetOrCreate("registry-different", cfg)
	assert.NotSame(t, cb1, cb3)
}

func TestCircuitBreaker_Execute_SuccessClosed(t *testing.T) {
	cfg := DefaultConfig()
	cb := New("exec-success", cfg)

	err := cb.Execute(context.Background(), func() error {
		time.Sleep(1 * time.Millisecond)
		return nil
	})
	assert.NoError(t, err)
	assert.Equal(t, StateClosed, cb.State())
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.TotalCalls))
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.SuccessfulCalls))
	assert.Equal(t, uint64(0), atomic.LoadUint64(&cb.metrics.FailedCalls))
}

func TestCircuitBreaker_Execute_FailureThresholdOpenAndReject(t *testing.T) {
	cfg := DefaultConfig()
	cfg.FailureThreshold = 2
	cfg.FailureRateThreshold = 1.0 // avoid rate influence; threshold will trigger
	cb := New("exec-fail", cfg)

	opErr := assert.AnError
	err := cb.Execute(context.Background(), func() error {
		return opErr
	})
	assert.Error(t, err)
	assert.Equal(t, StateClosed, cb.State()) // not yet open
	err = cb.Execute(context.Background(), func() error {
		return opErr
	})
	assert.Error(t, err)
	// After 2 failures it should be open
	assert.Equal(t, StateOpen, cb.State())

	// Next attempt should be rejected immediately
	rejectErr := cb.Execute(context.Background(), func() error {
		return nil
	})
	assert.Error(t, rejectErr)
	assert.True(t, strings.Contains(rejectErr.Error(), "circuit breaker 'exec-fail' is open"))
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.RejectedCalls))
}

func TestCircuitBreaker_OpenToHalfOpenToClosedAfterTimeout_SuccessThreshold(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Timeout = 10 * time.Millisecond
	cfg.SuccessThreshold = 1
	cfg.HalfOpenMaxCalls = 2
	cb := New("timeout-reset", cfg)

	// Open it
	cb.transitionTo(StateOpen)
	// Emulate timeout elapsed
	cb.openedAt.Store(time.Now().Add(-cfg.Timeout - 1*time.Millisecond))

	// Next execute should move to HALF_OPEN and allow
	err := cb.Execute(context.Background(), func() error {
		return nil
	})
	assert.NoError(t, err)
	// With SuccessThreshold=1, after first success in HALF_OPEN it should become CLOSED
	assert.Equal(t, StateClosed, cb.State())
}

func TestCircuitBreaker_HalfOpenMaxCalls(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Timeout = 5 * time.Millisecond
	cfg.SuccessThreshold = 10 // keep in HALF_OPEN after first success
	cfg.HalfOpenMaxCalls = 1
	cb := New("half-open-calls", cfg)

	// Open and expire timeout to allow transition to HALF_OPEN
	cb.transitionTo(StateOpen)
	cb.openedAt.Store(time.Now().Add(-cfg.Timeout - time.Millisecond))

	// First call: transition to HALF_OPEN and allowed
	err1 := cb.Execute(context.Background(), func() error {
		return nil
	})
	assert.NoError(t, err1)
	assert.Equal(t, StateHalfOpen, cb.State())

	// Second call should be rejected because HalfOpenMaxCalls=1
	err2 := cb.Execute(context.Background(), func() error {
		return nil
	})
	assert.Error(t, err2)
	assert.True(t, strings.Contains(err2.Error(), "is open"))
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.RejectedCalls))
	// Still HALF_OPEN because rejection doesn't change state
	assert.Equal(t, StateHalfOpen, cb.State())
}

func TestCircuitBreaker_FailureRateTriggersOpenAfterWindowFilled(t *testing.T) {
	cfg := DefaultConfig()
	cfg.SlidingWindowSize = 4
	cfg.FailureThreshold = 100     // do not trigger by count
	cfg.FailureRateThreshold = 0.5 // trigger by rate
	cb := New("failure-rate", cfg)

	// Pre-fill window with successes to avoid initial false entries
	for i := 0; i < cfg.SlidingWindowSize; i++ {
		assert.NoError(t, cb.Execute(context.Background(), func() error { return nil }))
	}
	assert.Equal(t, StateClosed, cb.State())

	// Two consecutive failures should push failure rate to 0.5 (2/4)
	_ = cb.Execute(context.Background(), func() error { return assert.AnError })
	assert.Equal(t, StateClosed, cb.State())
	_ = cb.Execute(context.Background(), func() error { return assert.AnError })
	// Should be open due to failure rate threshold reached (>=)
	assert.Equal(t, StateOpen, cb.State())
}

func TestCircuitBreaker_ExecuteWithFallback_OnOpen(t *testing.T) {
	cfg := DefaultConfig()
	cb := New("with-fallback", cfg)
	cb.transitionTo(StateOpen)
	// keep timeout not elapsed so should not allow reset
	cb.openedAt.Store(time.Now())

	var fallbackCalled int32
	err := cb.ExecuteWithFallback(context.Background(),
		func() error { return assert.AnError },
		func() error {
			atomic.AddInt32(&fallbackCalled, 1)
			return nil
		},
	)
	assert.NoError(t, err)
	assert.Equal(t, int32(1), atomic.LoadInt32(&fallbackCalled))
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.RejectedCalls))
}

func TestCircuitBreaker_GetHealthInfo(t *testing.T) {
	cfg := DefaultConfig()
	cfg.SlidingWindowSize = 3
	cb := New("health", cfg)

	// Run some calls
	assert.NoError(t, cb.Execute(context.Background(), func() error { return nil }))
	_ = cb.Execute(context.Background(), func() error { return assert.AnError })
	assert.NoError(t, cb.Execute(context.Background(), func() error { return nil }))

	info := cb.GetHealthInfo()
	assert.Equal(t, "health", info.Name)
	assert.Contains(t, []string{"CLOSED", "OPEN", "HALF_OPEN"}, info.State)
	assert.GreaterOrEqual(t, info.Metrics["total_calls"].(uint64), uint64(3))
	assert.GreaterOrEqual(t, info.Metrics["successful_calls"].(uint64), uint64(2))
	assert.GreaterOrEqual(t, info.Metrics["failed_calls"].(uint64), uint64(1))
	assert.GreaterOrEqual(t, info.Metrics["state_changes"].(uint64), uint64(0))
	// FailureRate should be between 0 and 1
	assert.GreaterOrEqual(t, info.FailureRate, 0.0)
	assert.LessOrEqual(t, info.FailureRate, 1.0)
}

func TestDistributedCoordinator_ReportState(t *testing.T) {
	// Setup breaker
	cb := New("service-A", DefaultConfig())

	var gotPath string
	var gotMethod string
	var gotContentType string
	reqCount := int32(0)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&reqCount, 1)
		gotPath = r.URL.Path
		gotMethod = r.Method
		gotContentType = r.Header.Get("Content-Type")
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	dc := NewDistributedCoordinator(srv.URL)
	dc.reportState(cb)

	// Ensure we made a POST to the expected path with header
	assert.Equal(t, "/circuit-breakers/state", gotPath)
	assert.Equal(t, "POST", gotMethod)
	assert.Equal(t, "application/json", gotContentType)
	assert.Equal(t, int32(1), atomic.LoadInt32(&reqCount))
}

func TestDistributedCoordinator_StartSync_Stop(t *testing.T) {
	cb := New("sync-service", DefaultConfig())

	var count int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/circuit-breakers/state" && r.Method == "POST" {
			atomic.AddInt32(&count, 1)
			w.WriteHeader(http.StatusOK)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	dc := NewDistributedCoordinator(srv.URL)
	dc.syncInterval = 20 * time.Millisecond
	dc.Register(cb)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		dc.StartSync(ctx)
	}()

	// Let a couple of ticks occur
	time.Sleep(70 * time.Millisecond)
	// Stop and cancel context
	dc.Stop()
	cancel()
	wg.Wait()

	// We should have observed at least one sync call
	assert.GreaterOrEqual(t, atomic.LoadInt32(&count), int32(1))
}
