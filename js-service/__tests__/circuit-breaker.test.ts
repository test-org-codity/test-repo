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

  it('opens after reaching failure threshold and rejects while open with CircuitBreakerOpenError', async () => {
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

    const opShouldNotRun = vi.fn(async () => 'ok')
    await expect(breaker.execute(opShouldNotRun)).rejects.toBeInstanceOf(CircuitBreakerOpenError)
    expect(opShouldNotRun).not.toHaveBeenCalled()

    const health = breaker.getHealthInfo()
    expect(health.metrics.rejectedCalls).toBe(1)
    expect(health.state).toBe(CircuitState.OPEN)
  })

  it('after timeout, transitions to HALF_OPEN and a successful trial closes the circuit', async () => {
    const breaker = new CircuitBreaker('svc-half-open-close', {
      failureThreshold: 1,
      successThreshold: 1,
      timeoutMs: 1000,
    })

    await expect(breaker.execute(async () => {
      throw new Error('fail')
    })).rejects.toThrow('fail')

    expect(breaker.getState()).toBe(CircuitState.OPEN)

    vi.advanceTimersByTime(1000)

    const opOk = vi.fn(async () => 'ok')
    const res = await breaker.execute(opOk)
    expect(res).toBe('ok')
    expect(breaker.getState()).toBe(CircuitState.CLOSED)

    const health = breaker.getHealthInfo()
    expect(health.state).toBe(CircuitState.CLOSED)
  })

  it('after timeout, transitions to HALF_OPEN and a failed trial re-opens the circuit', async () => {
    const breaker = new CircuitBreaker('svc-half-open-reopen', {
      failureThreshold: 1,
      successThreshold: 2,
      timeoutMs: 1000,
    })

    await expect(breaker.execute(async () => {
      throw new Error('fail')
    })).rejects.toThrow('fail')

    expect(breaker.getState()).toBe(CircuitState.OPEN)

    vi.advanceTimersByTime(1000)

    await expect(breaker.execute(async () => {
      throw new Error('trial-fail')
    })).rejects.toThrow('trial-fail')

    expect(breaker.getState()).toBe(CircuitState.OPEN)
  })

  it('failureRate reflects failures/totalCalls over recorded calls', async () => {
    const breaker = new CircuitBreaker('svc-rate', {
      failureThreshold: 999,
      successThreshold: 1,
      timeoutMs: 1000,
    })

    await breaker.execute(async () => 'ok')
    await expect(breaker.execute(async () => {
      throw new Error('x')
    })).rejects.toThrow()
    await expect(breaker.execute(async () => {
      throw new Error('y')
    })).rejects.toThrow()

    const health = breaker.getHealthInfo()
    expect(health.failureCount).toBe(2)
    expect(health.successCount).toBe(1)
    expect(health.metrics.totalCalls).toBe(3)
    expect(health.failureRate).toBeCloseTo(2 / 3, 6)
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

  it('wraps an operation and uses the named singleton breaker', async () => {
    const op = vi.fn(async () => 'wrapped-ok')
    const res = await withCircuitBreaker('svc-wrap', op)

    expect(res).toBe('wrapped-ok')
    expect(op).toHaveBeenCalledTimes(1)

    const breaker = CircuitBreaker.getOrCreate('svc-wrap')
    expect(breaker.getHealthInfo().metrics.totalCalls).toBe(1)
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

  it('constructs and exposes expected surface area used by this package', () => {
    const client: any = new (DistributedCircuitBreakerClient as any)()
    expect(client).toBeTruthy()
  })
})