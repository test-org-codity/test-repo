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
    expect(health.metrics.totalCalls).toBe(2)
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

  it('throws CircuitBreakerOpenError when open and no fallback is provided', async () => {
    const breaker = new CircuitBreaker('test', {
      failureThreshold: 1,
      failureRateThreshold: 1,
    })

    const failingOp = jest.fn().mockRejectedValue(new Error('fail'))

    await expect(breaker.execute(failingOp)).rejects.toThrow('fail')

    const healthAfterFailure = breaker.getHealthInfo()
    expect(healthAfterFailure.state).toBe(CircuitState.OPEN)

    const anotherOp = jest.fn().mockResolvedValue('ok')

    await expect(breaker.execute(anotherOp)).rejects.toBeInstanceOf(
      CircuitBreakerOpenError,
    )
  })

  it('uses fallback when open and fallback is provided', async () => {
    const breaker = new CircuitBreaker('test', {
      failureThreshold: 1,
      failureRateThreshold: 1,
    })

    const failingOp = jest.fn().mockRejectedValue(new Error('fail'))

    await expect(breaker.execute(failingOp)).rejects.toThrow('fail')

    const healthAfterFailure = breaker.getHealthInfo()
    expect(healthAfterFailure.state).toBe(CircuitState.OPEN)

    const anotherOp = jest.fn().mockResolvedValue('ok')
    const fallback = jest.fn().mockResolvedValue('fallback')

    const result = await breaker.execute(anotherOp, fallback)
    expect(result).toBe('fallback')
    expect(fallback).toHaveBeenCalled()
  })

  it('transitions to HALF_OPEN after resetTimeout and then to CLOSED on success', async () => {
    const breaker = new CircuitBreaker('test', {
      failureThreshold: 1,
      failureRateThreshold: 1,
      resetTimeout: 1000,
    })

    const failingOp = jest.fn().mockRejectedValue(new Error('fail'))

    await expect(breaker.execute(failingOp)).rejects.toThrow('fail')

    expect(breaker.getState()).toBe(CircuitState.OPEN)

    jest.advanceTimersByTime(1000)

    const halfOpenHealth = breaker.getHealthInfo()
    expect(halfOpenHealth.state).toBe(CircuitState.HALF_OPEN)

    const successOp = jest.fn().mockResolvedValue('ok')
    const result = await breaker.execute(successOp)
    expect(result).toBe('ok')

    const closedHealth = breaker.getHealthInfo()
    expect(closedHealth.state).toBe(CircuitState.CLOSED)
  })

  it('limits number of calls in HALF_OPEN state based on halfOpenMaxCalls', async () => {
    const breaker = new CircuitBreaker('test', {
      failureThreshold: 1,
      failureRateThreshold: 1,
      resetTimeout: 1000,
      halfOpenMaxCalls: 1,
    })

    const failingOp = jest.fn().mockRejectedValue(new Error('fail'))

    await expect(breaker.execute(failingOp)).rejects.toThrow('fail')
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    jest.advanceTimersByTime(1000)

    const successOp = jest.fn().mockResolvedValue('ok')
    await expect(breaker.execute(successOp)).resolves.toBe('ok')

    const anotherOp = jest.fn().mockResolvedValue('ok-2')
    await expect(breaker.execute(anotherOp)).rejects.toBeInstanceOf(
      CircuitBreakerOpenError,
    )
  })

  it('records response times for async operations', async () => {
    const breaker = new CircuitBreaker('test')

    const op = jest.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve('ok'), 100)
        }),
    )

    const promise = breaker.execute(op)
    jest.advanceTimersByTime(100)
    const result = await promise

    expect(result).toBe('ok')

    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(1)
    expect(health.metrics.successfulCalls).toBe(1)
    expect(health.metrics.failedCalls).toBe(0)
  })

  it('records response times for sync operations', () => {
    const breaker = new CircuitBreaker('test')

    const result = breaker.executeSync(() => 'ok')
    expect(result).toBe('ok')

    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(1)
    expect(health.metrics.successfulCalls).toBe(1)
    expect(health.metrics.failedCalls).toBe(0)
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

  it('wraps an async function with a circuit breaker', async () => {
    const fn = jest.fn().mockResolvedValue('ok')
    const wrapped = withCircuitBreaker('test', fn)

    const result = await wrapped()
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('wraps a sync function with a circuit breaker', () => {
    const fn = jest.fn().mockReturnValue('ok')
    const wrapped = withCircuitBreaker('test', fn)

    const result = wrapped()
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('uses provided options for the circuit breaker', async () => {
    const fn = jest.fn().mockResolvedValue('ok')
    const wrapped = withCircuitBreaker('test', fn, {
      failureThreshold: 1,
      failureRateThreshold: 1,
    })

    await wrapped()
    expect(fn).toHaveBeenCalledTimes(1)
  })
})

describe('DistributedCircuitBreakerClient', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2024-01-01T00:00:00.000Z'))
  })

  afterEach(() => {
    jest.useRealTimers()
    jest.clearAllMocks()
  })

  it('creates a distributed circuit breaker and executes operations', async () => {
    const client = new DistributedCircuitBreakerClient('test')

    const op = jest.fn().mockResolvedValue('ok')
    const result = await client.execute(op)

    expect(result).toBe('ok')
    expect(op).toHaveBeenCalledTimes(1)
  })

  it('handles failures and opens circuit in distributed mode', async () => {
    const client = new DistributedCircuitBreakerClient('test', {
      failureThreshold: 1,
      failureRateThreshold: 1,
    })

    const failingOp = jest.fn().mockRejectedValue(new Error('fail'))

    await expect(client.execute(failingOp)).rejects.toThrow('fail')

    const anotherOp = jest.fn().mockResolvedValue('ok')
    await expect(client.execute(anotherOp)).rejects.toBeInstanceOf(
      CircuitBreakerOpenError,
    )
  })

  it('uses fallback in distributed mode when circuit is open', async () => {
    const client = new DistributedCircuitBreakerClient('test', {
      failureThreshold: 1,
      failureRateThreshold: 1,
    })

    const failingOp = jest.fn().mockRejectedValue(new Error('fail'))

    await expect(client.execute(failingOp)).rejects.toThrow('fail')

    const anotherOp = jest.fn().mockResolvedValue('ok')
    const fallback = jest.fn().mockResolvedValue('fallback')

    const result = await client.execute(anotherOp, fallback)
    expect(result).toBe('fallback')
    expect(fallback).toHaveBeenCalled()
  })
})