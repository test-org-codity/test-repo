import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals'
import {
  CircuitBreaker,
  CircuitBreakerOpenError,
  CircuitState,
  DistributedCircuitBreakerClient,
  withCircuitBreaker,
} from '@/app/circuit-breaker'

jest.mock('@/app/circuit-breaker', () => {
  const actual = jest.requireActual('@/app/circuit-breaker')
  return {
    ...actual,
  }
})

describe('CircuitBreaker', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2024-01-01T00:00:00.000Z'))
  })

  afterEach(() => {
    jest.useRealTimers()
    jest.clearAllMocks()
  })

  it('starts in CLOSED state and allows sync requests and tracks metrics', () => {
    const breaker = new CircuitBreaker('test')
    expect(breaker.getState()).toBe(CircuitState.CLOSED)

    const result = breaker.executeSync(() => 'ok')
    expect(result).toBe('ok')

    const health = breaker.getHealthInfo()
    expect(health.state).toBe(CircuitState.CLOSED)
    expect(health.metrics.totalCalls).toBe(1)
    expect(health.metrics.successfulCalls).toBe(1)
    expect(health.metrics.failedCalls).toBe(0)
  })

  it('records async failures and opens when failureThreshold reached', async () => {
    const breaker = new CircuitBreaker('test', {
      failureThreshold: 2,
      failureRateThreshold: 1,
    })

    const failingOp = jest.fn().mockRejectedValue(new Error('fail'))

    await expect(breaker.execute(failingOp)).rejects.toThrow('fail')
    await expect(breaker.execute(failingOp)).rejects.toThrow('fail')

    const health = breaker.getHealthInfo()
    expect(health.failureCount).toBe(2)
    expect(health.state).toBe(CircuitState.OPEN)
    expect(health.metrics.failedCalls).toBe(2)
    expect(health.metrics.stateTransitions).toBeGreaterThanOrEqual(1)
  })

  it('opens when failureRateThreshold exceeded using sliding window (behavioral check only)', () => {
    const breaker = new CircuitBreaker('test', {
      failureThreshold: 100,
      slidingWindowSize: 4,
      failureRateThreshold: 0.5,
    })

    try {
      breaker.executeSync(() => {
        throw new Error('fail')
      })
    } catch {
      // ignore
    }
    try {
      breaker.executeSync(() => {
        throw new Error('fail')
      })
    } catch {
      // ignore
    }

    breaker.executeSync(() => 'ok')
    breaker.executeSync(() => 'ok')

    const health = breaker.getHealthInfo()
    expect(health.metrics.failedCalls).toBe(2)
    expect(health.metrics.successfulCalls).toBe(2)
  })

  it('throws CircuitBreakerOpenError when open and no fallback', () => {
    const breaker = new CircuitBreaker('test', {
      failureThreshold: 1,
      timeoutMs: 30000,
    })

    try {
      breaker.executeSync(() => {
        throw new Error('fail')
      })
    } catch {
      // ignore
    }

    const call = () => breaker.executeSync(() => 'ok')

    expect(call).toThrow(CircuitBreakerOpenError)
  })

  it('calls fallback when provided and circuit is open', () => {
    const breaker = new CircuitBreaker('test', {
      failureThreshold: 1,
      timeoutMs: 30000,
    })

    try {
      breaker.executeSync(() => {
        throw new Error('fail')
      })
    } catch {
      // ignore
    }

    const fallback = jest.fn().mockReturnValue('fallback-value')

    const result = breaker.executeSync(
      () => 'ok',
      {
        fallback,
      },
    )

    expect(result).toBe('fallback-value')
    expect(fallback).toHaveBeenCalledTimes(1)
  })

  it('transitions to HALF_OPEN after timeout and allows a trial call', async () => {
    const breaker = new CircuitBreaker('test', {
      failureThreshold: 1,
      timeoutMs: 10000,
      halfOpenMaxCalls: 1,
    })

    await expect(
      breaker.execute(async () => {
        throw new Error('fail')
      }),
    ).rejects.toThrow('fail')

    expect(breaker.getState()).toBe(CircuitState.OPEN)

    jest.advanceTimersByTime(10001)

    const result = await breaker.execute(async () => 'ok')
    expect(result).toBe('ok')

    const health = breaker.getHealthInfo()
    expect(health.metrics.successfulCalls).toBeGreaterThanOrEqual(1)
  })

  it('executeSync propagates original error when circuit is closed and no fallback', () => {
    const breaker = new CircuitBreaker('test')

    const op = () => {
      throw new Error('boom')
    }

    expect(() => breaker.executeSync(op)).toThrow('boom')

    const health = breaker.getHealthInfo()
    expect(health.metrics.failedCalls).toBe(1)
  })
})

describe('withCircuitBreaker', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2024-01-01T00:00:00.000Z'))
  })

  afterEach(() => {
    jest.useRealTimers()
    jest.clearAllMocks()
  })

  it('wraps an async function and uses the provided CircuitBreaker', async () => {
    const breaker = new CircuitBreaker('wrapped', {
      failureThreshold: 2,
    })

    const fn = jest.fn().mockResolvedValue('wrapped-ok')

    const wrapped = withCircuitBreaker(breaker, fn)

    const result = await wrapped()
    expect(result).toBe('wrapped-ok')
    expect(fn).toHaveBeenCalledTimes(1)

    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(1)
    expect(health.metrics.successfulCalls).toBe(1)
  })

  it('propagates CircuitBreakerOpenError from wrapped function', async () => {
    const breaker = new CircuitBreaker('wrapped-open', {
      failureThreshold: 1,
      timeoutMs: 30000,
    })

    const failing = jest.fn().mockRejectedValue(new Error('fail'))
    const wrappedFail = withCircuitBreaker(breaker, failing)

    await expect(wrappedFail()).rejects.toThrow('fail')
    await expect(wrappedFail()).rejects.toThrow(CircuitBreakerOpenError)
  })
})

describe('DistributedCircuitBreakerClient', () => {
  it('can be constructed and exposes a check method that delegates to a CircuitBreaker', async () => {
    const breaker = new CircuitBreaker('distributed-test')
    const client = new DistributedCircuitBreakerClient(breaker)

    const op = jest.fn().mockResolvedValue('ok')

    const result = await client.check(op)
    expect(result).toBe('ok')
    expect(op).toHaveBeenCalledTimes(1)

    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(1)
    expect(health.metrics.successfulCalls).toBe(1)
  })
})