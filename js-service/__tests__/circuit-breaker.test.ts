import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  CircuitBreaker,
  CircuitBreakerOpenError,
  CircuitState,
  withCircuitBreaker,
} from '@/app/circuit-breaker'

describe('CircuitBreaker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2020-01-01T00:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('starts CLOSED and exposes baseline health info shape', () => {
    const breaker = new CircuitBreaker('svc-a')

    expect(breaker.getState()).toBe(CircuitState.CLOSED)

    const health = breaker.getHealthInfo()
    expect(health.name).toBe('svc-a')
    expect(health.state).toBe(CircuitState.CLOSED)

    expect(health.metrics.totalCalls).toBe(0)
    expect(health.metrics.successfulCalls).toBe(0)
    expect(health.metrics.failedCalls).toBe(0)
    expect(health.metrics.rejectedCalls).toBe(0)

    expect(health.metrics.lastFailureTime).toBeNull()
    expect(health.metrics.lastSuccessTime).toBeNull()
  })

  it('getOrCreate returns the same instance for the same name and getRegistry returns a copy', () => {
    const b1 = CircuitBreaker.getOrCreate('svc-registry', { failureThreshold: 1 })
    const b2 = CircuitBreaker.getOrCreate('svc-registry', { failureThreshold: 999 })
    expect(b1).toBe(b2)

    const reg1 = CircuitBreaker.getRegistry()
    expect(reg1.get('svc-registry')).toBe(b1)

    reg1.delete('svc-registry')
    const reg2 = CircuitBreaker.getRegistry()
    expect(reg2.has('svc-registry')).toBe(true)
    expect(reg2.get('svc-registry')).toBe(b1)
  })

  it('execute records a successful call and returns the operation result', async () => {
    const breaker = new CircuitBreaker('svc-success')

    const nowSpy = vi.spyOn(Date, 'now')
    nowSpy.mockReturnValueOnce(1000).mockReturnValueOnce(1042)

    const op = vi.fn(async () => 'ok')
    const res = await breaker.execute(op)

    expect(res).toBe('ok')
    expect(op).toHaveBeenCalledTimes(1)

    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(1)
    expect(health.metrics.successfulCalls).toBe(1)
    expect(health.metrics.failedCalls).toBe(0)
    expect(health.metrics.rejectedCalls).toBe(0)
    expect(health.metrics.lastSuccessTime).toBeInstanceOf(Date)
    expect(health.metrics.lastFailureTime).toBeNull()
    expect(health.state).toBe(CircuitState.CLOSED)
    expect(health.metrics.averageResponseTimeMs).toBeGreaterThanOrEqual(0)
  })

  it('execute records a failed call, increments failedCalls, and rethrows error', async () => {
    const breaker = new CircuitBreaker('svc-fail')

    const nowSpy = vi.spyOn(Date, 'now')
    nowSpy.mockReturnValueOnce(2000).mockReturnValueOnce(2010)

    const err = new Error('boom')
    const op = vi.fn(async () => {
      throw err
    })

    await expect(breaker.execute(op)).rejects.toThrow('boom')
    expect(op).toHaveBeenCalledTimes(1)

    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(1)
    expect(health.metrics.successfulCalls).toBe(0)
    expect(health.metrics.failedCalls).toBe(1)
    expect(health.metrics.lastFailureTime).toBeInstanceOf(Date)
    expect(health.metrics.lastSuccessTime).toBeNull()
    expect(health.metrics.averageResponseTimeMs).toBeGreaterThanOrEqual(0)
  })

  it('opens after reaching failureThreshold and rejects subsequent calls with CircuitBreakerOpenError', async () => {
    const breaker = new CircuitBreaker('svc-open', { failureThreshold: 2, timeoutMs: 30000 })

    const opFail = vi.fn(async () => {
      throw new Error('fail')
    })

    await expect(breaker.execute(opFail)).rejects.toThrow('fail')
    await expect(breaker.execute(opFail)).rejects.toThrow('fail')

    expect(breaker.getState()).toBe(CircuitState.OPEN)

    const opOk = vi.fn(async () => 'ok')
    await expect(breaker.execute(opOk)).rejects.toBeInstanceOf(CircuitBreakerOpenError)
    expect(opOk).not.toHaveBeenCalled()

    const health = breaker.getHealthInfo()
    expect(health.metrics.rejectedCalls).toBe(1)
    expect(health.metrics.totalCalls).toBe(2)
    expect(health.metrics.failedCalls).toBe(2)
  })

  it('transitions to HALF_OPEN after timeout and closes after successThreshold successes', async () => {
    const breaker = new CircuitBreaker('svc-half-open', {
      failureThreshold: 1,
      successThreshold: 2,
      timeoutMs: 1000,
    })

    await expect(
      breaker.execute(async () => {
        throw new Error('x')
      }),
    ).rejects.toThrow('x')

    expect(breaker.getState()).toBe(CircuitState.OPEN)

    vi.advanceTimersByTime(1000)

    const opOk = vi.fn(async () => 'ok')

    const r1 = await breaker.execute(opOk)
    expect(r1).toBe('ok')
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)

    const r2 = await breaker.execute(opOk)
    expect(r2).toBe('ok')
    expect(breaker.getState()).toBe(CircuitState.CLOSED)
  })

  it('in HALF_OPEN, a failure re-opens the circuit', async () => {
    const breaker = new CircuitBreaker('svc-half-open-fail', {
      failureThreshold: 1,
      successThreshold: 2,
      timeoutMs: 1000,
    })

    await expect(
      breaker.execute(async () => {
        throw new Error('first')
      }),
    ).rejects.toThrow('first')
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    vi.advanceTimersByTime(1000)

    await expect(
      breaker.execute(async () => {
        throw new Error('half-open-fail')
      }),
    ).rejects.toThrow('half-open-fail')

    expect(breaker.getState()).toBe(CircuitState.OPEN)
  })

  it('withCircuitBreaker wraps a function and preserves return value', async () => {
    const breaker = new CircuitBreaker('svc-wrap')
    const fn = vi.fn(async (x: number) => `v:${x}`)

    const wrapped = withCircuitBreaker(breaker, fn)
    const res = await wrapped(7)

    expect(res).toBe('v:7')
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith(7)

    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(1)
    expect(health.metrics.successfulCalls).toBe(1)
  })

  it('withCircuitBreaker can be used without providing a breaker instance (name + config)', async () => {
    const fn = vi.fn(async () => 'wrapped-ok')

    const wrapped = withCircuitBreaker('svc-wrap2', fn, { failureThreshold: 1 })
    const res = await wrapped()

    expect(res).toBe('wrapped-ok')
    expect(fn).toHaveBeenCalledTimes(1)

    const breaker = CircuitBreaker.getOrCreate('svc-wrap2')
    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBeGreaterThanOrEqual(1)
  })
})