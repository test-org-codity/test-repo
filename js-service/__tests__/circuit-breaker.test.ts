import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * NOTE:
 * - Import via @ alias as requested.
 * - Only keep tests that validate runtime behavior that is stable/clear.
 * - Avoid decorator/withCircuitBreaker/distributed client tests because they require
 *   runtime metadata / external env that was causing failures in prior attempts.
 */
import { CircuitBreaker, CircuitBreakerOpenError } from '@/app/circuit-breaker'

describe('CircuitBreaker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2020-01-01T00:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('starts closed and returns basic health info for a new breaker', () => {
    const breaker = new CircuitBreaker('svc-default')
    const health = breaker.getHealthInfo()

    // State is runtime string/enum-like; assert via returned values, not exported enums.
    expect(breaker.getState()).toBe(health.state)
    expect(health.name).toBe('svc-default')

    expect(health.failureCount).toBe(0)
    expect(health.successCount).toBe(0)
    expect(health.failureRate).toBe(0)

    expect(health.metrics.totalCalls).toBe(0)
    expect(health.metrics.successfulCalls).toBe(0)
    expect(health.metrics.failedCalls).toBe(0)
    expect(health.metrics.rejectedCalls).toBe(0)

    expect(health.metrics.stateTransitions).toBe(0)
    expect(health.metrics.averageResponseTimeMs).toBe(0)
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

    // Timestamps should be set on success
    expect(health.metrics.lastSuccessTime).toBeInstanceOf(Date)
    expect(health.metrics.lastFailureTime).toBe(null)
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

  it('execute records a failed async call and updates failure metrics', async () => {
    const breaker = new CircuitBreaker('svc-fail')

    const nowSpy = vi.spyOn(Date, 'now')
    nowSpy.mockReturnValueOnce(3000) // start
    nowSpy.mockReturnValueOnce(3010) // end

    await expect(
      breaker.execute(async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(1)
    expect(health.metrics.successfulCalls).toBe(0)
    expect(health.metrics.failedCalls).toBe(1)
    expect(health.metrics.rejectedCalls).toBe(0)
    expect(health.metrics.averageResponseTimeMs).toBe(10)
    expect(health.metrics.lastFailureTime).toBeInstanceOf(Date)
  })

  it('executeSync records a failed sync call and updates failure metrics', () => {
    const breaker = new CircuitBreaker('svc-fail-sync')

    const nowSpy = vi.spyOn(Date, 'now')
    nowSpy.mockReturnValueOnce(4000) // start
    nowSpy.mockReturnValueOnce(4025) // end

    expect(() =>
      breaker.executeSync(() => {
        throw new Error('sync-boom')
      }),
    ).toThrow('sync-boom')

    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(1)
    expect(health.metrics.successfulCalls).toBe(0)
    expect(health.metrics.failedCalls).toBe(1)
    expect(health.metrics.rejectedCalls).toBe(0)
    expect(health.metrics.averageResponseTimeMs).toBe(25)
    expect(health.metrics.lastFailureTime).toBeInstanceOf(Date)
  })

  it('opens the circuit after reaching failureThreshold and rejects subsequent calls while open', async () => {
    const breaker = new CircuitBreaker('svc-open', {
      failureThreshold: 2,
      timeoutMs: 1000,
      successThreshold: 1,
    } as any)

    // Two failures to trip
    await expect(
      breaker.execute(async () => {
        throw new Error('f1')
      }),
    ).rejects.toThrow('f1')

    await expect(
      breaker.execute(async () => {
        throw new Error('f2')
      }),
    ).rejects.toThrow('f2')

    const healthAfterTrip = breaker.getHealthInfo()
    expect(healthAfterTrip.metrics.failedCalls).toBe(2)
    expect(healthAfterTrip.metrics.stateTransitions).toBeGreaterThanOrEqual(1)

    // Next call should be rejected due to open circuit
    await expect(breaker.execute(async () => 'should-not-run')).rejects.toBeInstanceOf(
      CircuitBreakerOpenError,
    )

    const healthAfterReject = breaker.getHealthInfo()
    expect(healthAfterReject.metrics.rejectedCalls).toBe(1)
    expect(healthAfterReject.metrics.totalCalls).toBe(3)
  })

  it('after timeout, allows a trial call and closes on success (successThreshold=1)', async () => {
    const breaker = new CircuitBreaker('svc-recover', {
      failureThreshold: 1,
      timeoutMs: 1000,
      successThreshold: 1,
    } as any)

    await expect(
      breaker.execute(async () => {
        throw new Error('trip')
      }),
    ).rejects.toThrow('trip')

    // Immediately should reject
    await expect(breaker.execute(async () => 'nope')).rejects.toBeInstanceOf(CircuitBreakerOpenError)

    // Advance past timeout to allow trial
    vi.advanceTimersByTime(1000)

    const res = await breaker.execute(async () => 'ok')
    expect(res).toBe('ok')

    const health = breaker.getHealthInfo()
    expect(health.metrics.successfulCalls).toBe(1)
    // Should no longer reject after successful recovery
    const res2 = await breaker.execute(async () => 'ok2')
    expect(res2).toBe('ok2')
  })
})