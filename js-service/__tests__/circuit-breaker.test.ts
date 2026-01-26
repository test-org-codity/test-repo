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
  })

  it('execute records a failed call, increments failure count, and throws original error', async () => {
    const breaker = new CircuitBreaker('svc-fail', { failureThreshold: 5 })
    const err = new Error('boom')

    const nowSpy = vi.spyOn(Date, 'now')
    nowSpy.mockReturnValueOnce(3000) // start
    nowSpy.mockReturnValueOnce(3025) // end

    await expect(breaker.execute(async () => Promise.reject(err))).rejects.toThrow('boom')

    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(1)
    expect(health.metrics.failedCalls).toBe(1)
    expect(health.metrics.successfulCalls).toBe(0)
    expect(health.metrics.rejectedCalls).toBe(0)
    expect(health.failureCount).toBe(1)
    expect(health.metrics.lastFailureTime).toBeInstanceOf(Date)
    expect(health.metrics.lastSuccessTime).toBe(null)
    expect(health.state).toBe(CircuitState.CLOSED)
  })

  it('transitions to OPEN after reaching failureThreshold and rejects calls until timeout', async () => {
    const breaker = new CircuitBreaker('svc-open', { failureThreshold: 2, timeoutMs: 30000 })

    await expect(breaker.execute(async () => Promise.reject(new Error('e1')))).rejects.toThrow()
    expect(breaker.getState()).toBe(CircuitState.CLOSED)

    await expect(breaker.execute(async () => Promise.reject(new Error('e2')))).rejects.toThrow()
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    await expect(breaker.execute(async () => 'should-not-run')).rejects.toBeInstanceOf(
      CircuitBreakerOpenError,
    )

    const health = breaker.getHealthInfo()
    expect(health.metrics.rejectedCalls).toBe(1)
  })

  it('moves to HALF_OPEN after timeout elapses and closes after enough successes', async () => {
    const breaker = new CircuitBreaker('svc-half-open', {
      failureThreshold: 1,
      successThreshold: 2,
      timeoutMs: 30000,
    })

    await expect(breaker.execute(async () => Promise.reject(new Error('fail')))).rejects.toThrow()
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    // not yet timed out
    await expect(breaker.execute(async () => 'x')).rejects.toBeInstanceOf(CircuitBreakerOpenError)

    vi.advanceTimersByTime(30000)

    // next call should be allowed (half-open probe)
    const r1 = await breaker.execute(async () => 'ok1')
    expect(r1).toBe('ok1')
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)

    const r2 = await breaker.execute(async () => 'ok2')
    expect(r2).toBe('ok2')
    expect(breaker.getState()).toBe(CircuitState.CLOSED)

    const health = breaker.getHealthInfo()
    expect(health.successCount).toBeGreaterThanOrEqual(2)
  })

  it('in HALF_OPEN, a failure re-opens the circuit', async () => {
    const breaker = new CircuitBreaker('svc-half-open-fail', {
      failureThreshold: 1,
      successThreshold: 2,
      timeoutMs: 30000,
    })

    await expect(breaker.execute(async () => Promise.reject(new Error('fail')))).rejects.toThrow()
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    vi.advanceTimersByTime(30000)

    // first probe fails -> should open again
    await expect(breaker.execute(async () => Promise.reject(new Error('probe-fail')))).rejects.toThrow(
      'probe-fail',
    )
    expect(breaker.getState()).toBe(CircuitState.OPEN)
  })

  it('reset returns breaker to CLOSED and clears counts', async () => {
    const breaker = new CircuitBreaker('svc-reset', { failureThreshold: 1 })

    await expect(breaker.execute(async () => Promise.reject(new Error('fail')))).rejects.toThrow()
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    breaker.reset()
    expect(breaker.getState()).toBe(CircuitState.CLOSED)
    const health = breaker.getHealthInfo()
    expect(health.failureCount).toBe(0)
    expect(health.successCount).toBe(0)
    expect(health.metrics.totalCalls).toBeGreaterThanOrEqual(0)
  })
})

describe('DistributedCircuitBreakerClient', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2020-01-01T00:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('exposes expected API surface (create/getBreaker/execute)', () => {
    const clientAny: any = DistributedCircuitBreakerClient as any

    // Support both static-factory and constructor patterns depending on implementation
    const client =
      typeof clientAny?.create === 'function'
        ? clientAny.create()
        : typeof clientAny === 'function'
          ? new clientAny()
          : clientAny

    expect(client).toBeTruthy()
    expect(typeof client.getBreaker).toBe('function')
    expect(typeof client.execute).toBe('function')
  })

  it('getBreaker returns a CircuitBreaker instance', () => {
    const clientAny: any = DistributedCircuitBreakerClient as any
    const client =
      typeof clientAny?.create === 'function'
        ? clientAny.create()
        : typeof clientAny === 'function'
          ? new clientAny()
          : clientAny

    const breaker = client.getBreaker('svc')
    expect(breaker).toBeInstanceOf(CircuitBreaker)
    expect(breaker.getHealthInfo().name).toBe('svc')
  })

  it('execute delegates to breaker.execute and returns result', async () => {
    const clientAny: any = DistributedCircuitBreakerClient as any
    const client =
      typeof clientAny?.create === 'function'
        ? clientAny.create()
        : typeof clientAny === 'function'
          ? new clientAny()
          : clientAny

    const res = await client.execute('svc-exec', async () => 'ok')
    expect(res).toBe('ok')

    const breaker = client.getBreaker('svc-exec')
    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(1)
    expect(health.metrics.successfulCalls).toBe(1)
  })
})

describe('withCircuitBreaker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2020-01-01T00:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('wraps an async function and runs it through a breaker', async () => {
    const wrapped = withCircuitBreaker('decorated-svc', async (x: string) => `hi ${x}`)
    expect(typeof wrapped).toBe('function')

    const res = await wrapped('there')
    expect(res).toBe('hi there')

    const breaker = CircuitBreaker.getOrCreate('decorated-svc')
    expect(breaker.getHealthInfo().metrics.totalCalls).toBeGreaterThanOrEqual(1)
  })

  it('supports being used with default options object and preserves return', async () => {
    const wrapped = withCircuitBreaker('decorated-svc-2', { failureThreshold: 2 }, async () => 'ok2')
    const res = await wrapped()
    expect(res).toBe('ok2')
  })
})