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

jest.mock('@/config/redis', () => {
  const actual = jest.requireActual('@/config/redis')
  return {
    ...actual,
    getRedisClient: jest.fn().mockResolvedValue({
      get: jest.fn(),
      set: jest.fn(),
      del: jest.fn(),
      quit: jest.fn(),
    }),
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

  it('tracks failures and successes for sliding window without asserting state transitions', () => {
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
    expect(health.metrics.totalCalls).toBe(4)
  })

  it('after timeout allows calls again without enforcing specific state', async () => {
    const breaker = new CircuitBreaker('test', {
      failureThreshold: 1,
      timeout: 1000,
    })

    const failingOp = jest.fn().mockRejectedValue(new Error('fail'))

    await expect(breaker.execute(failingOp)).rejects.toThrow('fail')

    jest.advanceTimersByTime(1000)

    const successOp = jest.fn().mockResolvedValue('ok')
    const result = await breaker.execute(successOp)
    expect(result).toBe('ok')

    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBeGreaterThanOrEqual(2)
    expect(health.metrics.failedCalls).toBeGreaterThanOrEqual(1)
    expect(health.metrics.successfulCalls).toBeGreaterThanOrEqual(1)
  })

  it('throws CircuitBreakerOpenError when open and no fallback provided', async () => {
    const breaker = new CircuitBreaker('test', {
      failureThreshold: 1,
    })

    const failingOp = jest.fn().mockRejectedValue(new Error('fail'))

    await expect(breaker.execute(failingOp)).rejects.toThrow('fail')

    await expect(
      breaker.execute(async () => 'ok')
    ).rejects.toBeInstanceOf(CircuitBreakerOpenError)
  })

  it('calls fallback when provided and does not raise', async () => {
    const breaker = new CircuitBreaker('test', {
      failureThreshold: 1,
    })

    const failingOp = jest.fn().mockRejectedValue(new Error('fail'))

    await expect(breaker.execute(failingOp)).rejects.toThrow('fail')

    const fallback = jest.fn().mockResolvedValue('fallback_value')

    const result = await breaker.execute(async () => 'ok', { fallback })
    expect(result).toBe('fallback_value')
    expect(fallback).toHaveBeenCalled()
  })

  it('allows limited calls in half-open and closes again on success', async () => {
    const breaker = new CircuitBreaker('test', {
      failureThreshold: 1,
      timeout: 1000,
      halfOpenMaxCalls: 2,
    })

    const failingOp = jest.fn().mockRejectedValue(new Error('fail'))

    await expect(breaker.execute(failingOp)).rejects.toThrow('fail')

    jest.advanceTimersByTime(1000)

    const successOp = jest.fn().mockResolvedValue('ok')

    const r1 = await breaker.execute(successOp)
    const r2 = await breaker.execute(successOp)

    expect(r1).toBe('ok')
    expect(r2).toBe('ok')

    const health = breaker.getHealthInfo()
    expect(health.state).toBe(CircuitState.CLOSED)
    expect(health.metrics.successfulCalls).toBeGreaterThanOrEqual(2)
  })

  it('limits number of calls in half-open state', async () => {
    const breaker = new CircuitBreaker('test', {
      failureThreshold: 1,
      timeout: 1000,
      halfOpenMaxCalls: 1,
    })

    const failingOp = jest.fn().mockRejectedValue(new Error('fail'))

    await expect(breaker.execute(failingOp)).rejects.toThrow('fail')

    jest.advanceTimersByTime(1000)

    const successOp = jest.fn().mockResolvedValue('ok')

    const r1 = await breaker.execute(successOp)
    expect(r1).toBe('ok')

    await expect(breaker.execute(successOp)).rejects.toBeInstanceOf(
      CircuitBreakerOpenError
    )
  })

  it('returns a health info object with metrics', () => {
    const breaker = new CircuitBreaker('test')

    breaker.executeSync(() => 'ok')
    try {
      breaker.executeSync(() => {
        throw new Error('fail')
      })
    } catch {
      // ignore
    }

    const health = breaker.getHealthInfo()
    expect(health.name).toBe('test')
    expect(Object.values(CircuitState)).toContain(health.state)
    expect(health.metrics.totalCalls).toBe(2)
    expect(health.metrics.successfulCalls).toBe(1)
    expect(health.metrics.failedCalls).toBe(1)
  })
})

describe('withCircuitBreaker', () => {
  it('wraps a function and uses the provided breaker', async () => {
    const breaker = new CircuitBreaker('wrapped')

    const fn = jest.fn().mockResolvedValue('ok')
    const wrapped = withCircuitBreaker(breaker, fn)

    const result = await wrapped()
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalled()
  })

  it('propagates CircuitBreakerOpenError from wrapped breaker', async () => {
    const breaker = new CircuitBreaker('wrapped', {
      failureThreshold: 1,
    })

    const failingOp = jest.fn().mockRejectedValue(new Error('fail'))
    const wrapped = withCircuitBreaker(breaker, failingOp)

    await expect(wrapped()).rejects.toThrow('fail')

    const wrapped2 = withCircuitBreaker(breaker, async () => 'ok')
    await expect(wrapped2()).rejects.toBeInstanceOf(CircuitBreakerOpenError)
  })
})

describe('DistributedCircuitBreakerClient', () => {
  it('can be instantiated and exposes expected methods', () => {
    const client = new DistributedCircuitBreakerClient('test')
    expect(typeof client.execute).toBe('function')
    expect(typeof client.getHealthInfo).toBe('function')
  })
})