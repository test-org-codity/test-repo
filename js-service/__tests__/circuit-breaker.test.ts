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

  it('starts CLOSED and health info reflects initial state and defaults', () => {
    const breaker = new CircuitBreaker('svc-a')
    expect(breaker.getState()).toBe(CircuitState.CLOSED)

    const health = breaker.getHealthInfo()
    expect(health.name).toBe('svc-a')
    expect(health.state).toBe(CircuitState.CLOSED)
    expect(health.failureCount).toBe(0)
    expect(health.successCount).toBe(0)
    expect(health.failureRate).toBe(0)

    expect(health.metrics.totalCalls).toBe(0)
    expect(health.metrics.successfulCalls).toBe(0)
    expect(health.metrics.failedCalls).toBe(0)
    expect(health.metrics.rejectedCalls).toBe(0)
    expect(health.metrics.stateTransitions).toBe(0)
    expect(health.metrics.lastFailureTime).toBeNull()
    expect(health.metrics.lastSuccessTime).toBeNull()
    expect(health.metrics.averageResponseTimeMs).toBe(0)

    expect(health.config).toEqual({
      failureThreshold: 5,
      successThreshold: 3,
      timeoutMs: 30000,
    })
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

  it('execute records a successful call, updates timestamps and average response time', async () => {
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
    expect(health.metrics.averageResponseTimeMs).toBe(42)
    expect(health.state).toBe(CircuitState.CLOSED)
  })

  it('execute records a failed call, updates timestamps and average response time, and rethrows error', async () => {
    const breaker = new CircuitBreaker('svc-fail')

    const nowSpy = vi.spyOn(Date, 'now')
    nowSpy.mockReturnValueOnce(2000).mockReturnValueOnce(2050)

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
    expect(health.metrics.rejectedCalls).toBe(0)
    expect(health.metrics.lastFailureTime).toBeInstanceOf(Date)
    expect(health.metrics.lastSuccessTime).toBeNull()
    expect(health.metrics.averageResponseTimeMs).toBe(50)
  })

  it('opens after reaching failureThreshold and rejects calls while OPEN', async () => {
    const breaker = new CircuitBreaker('svc-open', {
      failureThreshold: 2,
      successThreshold: 1,
      timeoutMs: 1000,
    })

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
  })

  it('does not transition to HALF_OPEN before timeout elapses; transitions after timeout on next attempt', async () => {
    const breaker = new CircuitBreaker('svc-timeout', {
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

    vi.advanceTimersByTime(999)
    const opBefore = vi.fn(async () => 'ok')
    await expect(breaker.execute(opBefore)).rejects.toBeInstanceOf(CircuitBreakerOpenError)
    expect(opBefore).not.toHaveBeenCalled()
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    vi.advanceTimersByTime(2)
    const opAfter = vi.fn(async () => 'ok')
    const res = await breaker.execute(opAfter)
    expect(res).toBe('ok')
    expect(opAfter).toHaveBeenCalledTimes(1)
    expect(breaker.getState()).toBe(CircuitState.CLOSED)
  })

  it('in HALF_OPEN, a successful probe contributes toward successThreshold and can close the circuit', async () => {
    const breaker = new CircuitBreaker('svc-halfopen-success', {
      failureThreshold: 1,
      successThreshold: 2,
      timeoutMs: 1000,
    })

    await expect(
      breaker.execute(async () => {
        throw new Error('fail')
      }),
    ).rejects.toThrow('fail')
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    vi.advanceTimersByTime(1000)

    const op1 = vi.fn(async () => 'ok1')
    const r1 = await breaker.execute(op1)
    expect(r1).toBe('ok1')
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)

    const op2 = vi.fn(async () => 'ok2')
    const r2 = await breaker.execute(op2)
    expect(r2).toBe('ok2')
    expect(breaker.getState()).toBe(CircuitState.CLOSED)
  })

  it('in HALF_OPEN, a failure immediately re-opens the circuit', async () => {
    const breaker = new CircuitBreaker('svc-halfopen-fail', {
      failureThreshold: 1,
      successThreshold: 2,
      timeoutMs: 1000,
    })

    await expect(
      breaker.execute(async () => {
        throw new Error('fail')
      }),
    ).rejects.toThrow('fail')
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    vi.advanceTimersByTime(1000)

    await expect(
      breaker.execute(async () => {
        throw new Error('probe-fail')
      }),
    ).rejects.toThrow('probe-fail')

    expect(breaker.getState()).toBe(CircuitState.OPEN)
  })

  it('reset returns to CLOSED and clears counts (but keeps identity/name)', async () => {
    const breaker = new CircuitBreaker('svc-reset', {
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

    breaker.reset()
    expect(breaker.getState()).toBe(CircuitState.CLOSED)

    const health = breaker.getHealthInfo()
    expect(health.name).toBe('svc-reset')
    expect(health.failureCount).toBe(0)
    expect(health.successCount).toBe(0)
    expect(health.metrics.totalCalls).toBe(0)
    expect(health.metrics.successfulCalls).toBe(0)
    expect(health.metrics.failedCalls).toBe(0)
    expect(health.metrics.rejectedCalls).toBe(0)
    expect(health.metrics.lastFailureTime).toBeNull()
    expect(health.metrics.lastSuccessTime).toBeNull()
    expect(health.metrics.averageResponseTimeMs).toBe(0)
  })

  it('failureRate reflects failures vs total calls', async () => {
    const breaker = new CircuitBreaker('svc-rate', {
      failureThreshold: 999,
      successThreshold: 1,
      timeoutMs: 1000,
    })

    await breaker.execute(async () => 'ok')
    await expect(
      breaker.execute(async () => {
        throw new Error('fail')
      }),
    ).rejects.toThrow('fail')
    await expect(
      breaker.execute(async () => {
        throw new Error('fail2')
      }),
    ).rejects.toThrow('fail2')

    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(3)
    expect(health.metrics.successfulCalls).toBe(1)
    expect(health.metrics.failedCalls).toBe(2)
    expect(health.failureRate).toBeCloseTo(2 / 3, 5)
  })

  it('withCircuitBreaker wraps an operation and uses named breaker', async () => {
    const op = vi.fn(async (n: number) => n + 1)
    const wrapped = withCircuitBreaker('svc-wrap', op)

    const res = await wrapped(1)
    expect(res).toBe(2)
    expect(op).toHaveBeenCalledTimes(1)

    const breaker = CircuitBreaker.getOrCreate('svc-wrap')
    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBeGreaterThanOrEqual(1)
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

  it('can register and retrieve breaker health through the client', async () => {
    const breaker = CircuitBreaker.getOrCreate('svc-dist', {
      failureThreshold: 1,
      successThreshold: 1,
      timeoutMs: 1000,
    })

    await breaker.execute(async () => 'ok')

    const client = new DistributedCircuitBreakerClient()
    const info = client.getCircuitHealth('svc-dist')
    expect(info).not.toBeNull()
    expect(info?.name).toBe('svc-dist')
    expect(info?.metrics.totalCalls).toBeGreaterThanOrEqual(1)
  })

  it('unknown circuit health returns null/undefined (implementation dependent)', () => {
    const client = new DistributedCircuitBreakerClient()
    const info = client.getCircuitHealth('does-not-exist')
    expect(info == null).toBe(true)
  })
})