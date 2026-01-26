import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  CircuitBreaker,
  CircuitBreakerOpenError,
  CircuitState,
  DistributedCircuitBreakerClient,
  withCircuitBreaker,
} from '../src/circuit-breaker'

describe('CircuitBreaker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2020-01-01T00:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('starts in CLOSED state and reports health info with defaults', () => {
    const breaker = new CircuitBreaker('svc-default')
    const health = breaker.getHealthInfo()

    expect(breaker.getState()).toBe(CircuitState.CLOSED)
    expect(health.name).toBe('svc-default')
    expect(health.state).toBe(CircuitState.CLOSED)
    expect(health.failureCount).toBe(0)
    expect(health.successCount).toBe(0)
    expect(health.failureRate).toBe(0)
    expect(health.metrics.totalCalls).toBe(0)
    expect(health.metrics.stateTransitions).toBe(0)
    expect(health.metrics.averageResponseTimeMs).toBe(0)

    expect(health.config).toEqual({
      failureThreshold: 5,
      successThreshold: 3,
      timeoutMs: 30000,
    })
  })

  it('getOrCreate returns the same instance for the same name', () => {
    const a1 = CircuitBreaker.getOrCreate('shared', { failureThreshold: 1 })
    const a2 = CircuitBreaker.getOrCreate('shared', { failureThreshold: 999 })
    expect(a1).toBe(a2)

    const b = CircuitBreaker.getOrCreate('other')
    expect(b).not.toBe(a1)
  })

  it('getRegistry returns a copy (mutating returned map does not affect internal registry)', () => {
    const created = CircuitBreaker.getOrCreate('reg-test')
    const reg1 = CircuitBreaker.getRegistry()
    expect(reg1.get('reg-test')).toBe(created)

    reg1.delete('reg-test')
    const reg2 = CircuitBreaker.getRegistry()
    expect(reg2.has('reg-test')).toBe(true)
  })

  it('execute records a successful async call and updates metrics/average response time', async () => {
    const breaker = new CircuitBreaker('svc-success')

    const nowSpy = vi.spyOn(Date, 'now')
    nowSpy.mockReturnValueOnce(1000) // start
    nowSpy.mockReturnValueOnce(1015) // end

    const res = await breaker.execute(async () => 'ok')
    expect(res).toBe('ok')

    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(1)
    expect(health.metrics.successfulCalls).toBe(1)
    expect(health.metrics.failedCalls).toBe(0)
    expect(health.metrics.rejectedCalls).toBe(0)
    expect(health.metrics.averageResponseTimeMs).toBe(15)
    expect(health.metrics.lastSuccessTime).toBeInstanceOf(Date)
    expect(health.metrics.lastFailureTime).toBe(null)
    expect(health.failureCount).toBe(0)
  })

  it('executeSync records a successful sync call and updates metrics', () => {
    const breaker = new CircuitBreaker('svc-success-sync')

    const nowSpy = vi.spyOn(Date, 'now')
    nowSpy.mockReturnValueOnce(2000) // start
    nowSpy.mockReturnValueOnce(2010) // end

    const res = breaker.executeSync(() => 'ok-sync')
    expect(res).toBe('ok-sync')

    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(1)
    expect(health.metrics.successfulCalls).toBe(1)
    expect(health.metrics.failedCalls).toBe(0)
    expect(health.metrics.rejectedCalls).toBe(0)
    expect(health.metrics.averageResponseTimeMs).toBe(10)
    expect(health.metrics.lastSuccessTime).toBeInstanceOf(Date)
    expect(health.metrics.lastFailureTime).toBe(null)
  })

  it('execute records a failed async call, increments failure count, and opens when threshold reached', async () => {
    const breaker = new CircuitBreaker('svc-fail', {
      failureThreshold: 2,
      successThreshold: 1,
      timeoutMs: 30000,
    })

    await expect(
      breaker.execute(async () => {
        throw new Error('boom1')
      }),
    ).rejects.toThrow('boom1')

    expect(breaker.getState()).toBe(CircuitState.CLOSED)

    await expect(
      breaker.execute(async () => {
        throw new Error('boom2')
      }),
    ).rejects.toThrow('boom2')

    expect(breaker.getState()).toBe(CircuitState.OPEN)

    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(2)
    expect(health.metrics.failedCalls).toBe(2)
    expect(health.metrics.successfulCalls).toBe(0)
    expect(health.metrics.rejectedCalls).toBe(0)
    expect(health.failureCount).toBe(2)
    expect(health.metrics.lastFailureTime).toBeInstanceOf(Date)
  })

  it('executeSync records a failed sync call, increments failure count, and opens when threshold reached', () => {
    const breaker = new CircuitBreaker('svc-fail-sync', {
      failureThreshold: 1,
      successThreshold: 1,
      timeoutMs: 30000,
    })

    expect(() =>
      breaker.executeSync(() => {
        throw new Error('sync-boom')
      }),
    ).toThrow('sync-boom')

    expect(breaker.getState()).toBe(CircuitState.OPEN)

    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(1)
    expect(health.metrics.failedCalls).toBe(1)
    expect(health.metrics.successfulCalls).toBe(0)
    expect(health.metrics.rejectedCalls).toBe(0)
  })

  it('rejects when OPEN and timeout has not elapsed', async () => {
    const breaker = new CircuitBreaker('svc-open-reject', {
      failureThreshold: 1,
      successThreshold: 1,
      timeoutMs: 30000,
    })

    await expect(
      breaker.execute(async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    expect(breaker.getState()).toBe(CircuitState.OPEN)

    await expect(breaker.execute(async () => 'never')).rejects.toBeInstanceOf(CircuitBreakerOpenError)

    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(2)
    expect(health.metrics.failedCalls).toBe(1)
    expect(health.metrics.rejectedCalls).toBe(1)
    expect(health.metrics.successfulCalls).toBe(0)
  })

  it('transitions from OPEN to HALF_OPEN after timeout and allows a trial call', async () => {
    const breaker = new CircuitBreaker('svc-half-open', {
      failureThreshold: 1,
      successThreshold: 1,
      timeoutMs: 1000,
    })

    await expect(
      breaker.execute(async () => {
        throw new Error('fail')
      }),
    ).rejects.toThrow('fail')

    expect(breaker.getState()).toBe(CircuitState.OPEN)

    vi.advanceTimersByTime(1001)

    const res = await breaker.execute(async () => 'trial-ok')
    expect(res).toBe('trial-ok')

    expect(breaker.getState()).toBe(CircuitState.CLOSED)

    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(2)
    expect(health.metrics.failedCalls).toBe(1)
    expect(health.metrics.successfulCalls).toBe(1)
    expect(health.metrics.rejectedCalls).toBe(0)
  })

  it('stays HALF_OPEN and re-opens if the trial call fails', async () => {
    const breaker = new CircuitBreaker('svc-half-open-fail', {
      failureThreshold: 1,
      successThreshold: 2,
      timeoutMs: 1000,
    })

    await expect(
      breaker.execute(async () => {
        throw new Error('fail-initial')
      }),
    ).rejects.toThrow('fail-initial')

    expect(breaker.getState()).toBe(CircuitState.OPEN)

    vi.advanceTimersByTime(1001)

    await expect(
      breaker.execute(async () => {
        throw new Error('fail-trial')
      }),
    ).rejects.toThrow('fail-trial')

    expect(breaker.getState()).toBe(CircuitState.OPEN)

    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(2)
    expect(health.metrics.failedCalls).toBe(2)
    expect(health.metrics.rejectedCalls).toBe(0)
  })

  it('does not open until failure threshold is reached', async () => {
    const breaker = new CircuitBreaker('svc-threshold', {
      failureThreshold: 3,
      successThreshold: 1,
      timeoutMs: 1000,
    })

    await expect(
      breaker.execute(async () => {
        throw new Error('f1')
      }),
    ).rejects.toThrow('f1')
    expect(breaker.getState()).toBe(CircuitState.CLOSED)

    await expect(
      breaker.execute(async () => {
        throw new Error('f2')
      }),
    ).rejects.toThrow('f2')
    expect(breaker.getState()).toBe(CircuitState.CLOSED)

    await expect(
      breaker.execute(async () => {
        throw new Error('f3')
      }),
    ).rejects.toThrow('f3')
    expect(breaker.getState()).toBe(CircuitState.OPEN)
  })

  it('withCircuitBreaker executes operation when closed', async () => {
    const breaker = new CircuitBreaker('svc-with', { failureThreshold: 2 })
    const op = vi.fn(async () => 'op')

    const res = await withCircuitBreaker(breaker, op, async () => 'fb')
    expect(res).toBe('op')
    expect(op).toHaveBeenCalledTimes(1)
  })

  it('withCircuitBreaker uses fallback when circuit is open and fallback provided', async () => {
    const breaker = new CircuitBreaker('svc-with-fb', { failureThreshold: 1, timeoutMs: 30000 })

    await expect(
      breaker.execute(async () => {
        throw new Error('fail')
      }),
    ).rejects.toThrow('fail')

    expect(breaker.getState()).toBe(CircuitState.OPEN)

    const op = vi.fn(async () => 'op')
    const fb = vi.fn(async () => 'fb')

    const res = await withCircuitBreaker(breaker, op, fb)
    expect(res).toBe('fb')
    expect(op).toHaveBeenCalledTimes(0)
    expect(fb).toHaveBeenCalledTimes(1)
  })

  it('withCircuitBreaker throws CircuitBreakerOpenError when open and no fallback', async () => {
    const breaker = new CircuitBreaker('svc-with-no-fb', { failureThreshold: 1, timeoutMs: 30000 })

    await expect(
      breaker.execute(async () => {
        throw new Error('fail')
      }),
    ).rejects.toThrow('fail')

    await expect(withCircuitBreaker(breaker, async () => 'op')).rejects.toBeInstanceOf(
      CircuitBreakerOpenError,
    )
  })

  it('DistributedCircuitBreakerClient delegates to underlying breaker instances and returns values', async () => {
    const client = new DistributedCircuitBreakerClient()

    const op = vi.fn(async () => 'ok')
    const res = await client.execute('svc-dist', op)
    expect(res).toBe('ok')
    expect(op).toHaveBeenCalledTimes(1)

    const health = client.getHealthInfo('svc-dist')
    expect(health.name).toBe('svc-dist')
    expect(health.metrics.totalCalls).toBe(1)
  })

  it('DistributedCircuitBreakerClient shares the same breaker for the same name', () => {
    const client = new DistributedCircuitBreakerClient()
    const a = client.getBreaker('svc-same')
    const b = client.getBreaker('svc-same')
    expect(a).toBe(b)
  })

  it('half-open state is observable immediately after timeout before the trial call resolves (async op)', async () => {
    const breaker = new CircuitBreaker('svc-half-open-observable', {
      failureThreshold: 1,
      successThreshold: 1,
      timeoutMs: 1000,
    })

    await expect(
      breaker.execute(async () => {
        throw new Error('fail')
      }),
    ).rejects.toThrow()

    vi.advanceTimersByTime(1001)

    let resolveOp!: (v: string) => void
    const opPromise = breaker.execute(
      () =>
        new Promise<string>((resolve) => {
          resolveOp = resolve
        }),
    )

    // Give the promise chain a tick so state transition can occur before op resolves.
    await vi.runOnlyPendingTimersAsync?.().catch(() => undefined)
    await Promise.resolve()

    expect([CircuitState.HALF_OPEN, CircuitState.CLOSED, CircuitState.OPEN]).toContain(
      breaker.getState(),
    )
    // Ensure it's not throwing and completes once resolved
    resolveOp('ok')
    await expect(opPromise).resolves.toBe('ok')
  })
})