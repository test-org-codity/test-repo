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

    await expect(
      breaker.execute(async () => 'should-not-run')
    ).rejects.toBeInstanceOf(CircuitBreakerOpenError)
  })

  it('uses fallback when circuit is open and fallback is provided', async () => {
    const breaker = new CircuitBreaker('test', {
      failureThreshold: 1,
      failureRateThreshold: 1,
    })

    const failingOp = jest.fn().mockRejectedValue(new Error('fail'))

    await expect(breaker.execute(failingOp)).rejects.toThrow('fail')

    const fallback = jest.fn().mockResolvedValue('fallback-value')

    const result = await breaker.execute(async () => 'should-not-run', {
      fallback,
    })

    expect(result).toBe('fallback-value')
    expect(fallback).toHaveBeenCalledTimes(1)
  })

  it('executeSync throws CircuitBreakerOpenError when open and no fallback is provided', () => {
    const breaker = new CircuitBreaker('test', {
      failureThreshold: 1,
      failureRateThreshold: 1,
    })

    try {
      breaker.executeSync(() => {
        throw new Error('fail')
      })
    } catch {
      // ignore
    }

    expect(() =>
      breaker.executeSync(() => 'should-not-run')
    ).toThrow(CircuitBreakerOpenError)
  })

  it('executeSync uses fallback when circuit is open and fallback is provided', () => {
    const breaker = new CircuitBreaker('test', {
      failureThreshold: 1,
      failureRateThreshold: 1,
    })

    try {
      breaker.executeSync(() => {
        throw new Error('fail')
      })
    } catch {
      // ignore
    }

    const fallback = jest.fn().mockReturnValue('fallback-sync')

    const result = breaker.executeSync(() => 'should-not-run', { fallback })

    expect(result).toBe('fallback-sync')
    expect(fallback).toHaveBeenCalledTimes(1)
  })

  it('withCircuitBreaker wraps async function and uses provided breaker', async () => {
    const breaker = new CircuitBreaker('wrapped', {
      failureThreshold: 2,
      failureRateThreshold: 1,
    })

    const fn = jest.fn().mockResolvedValue('ok')
    const wrapped = withCircuitBreaker(fn, breaker)

    const result = await wrapped()
    expect(result).toBe('ok')

    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(1)
    expect(health.metrics.successfulCalls).toBe(1)
  })

  it('withCircuitBreaker propagates errors through breaker', async () => {
    const breaker = new CircuitBreaker('wrapped', {
      failureThreshold: 1,
      failureRateThreshold: 1,
    })

    const fn = jest.fn().mockRejectedValue(new Error('wrapped-fail'))
    const wrapped = withCircuitBreaker(fn, breaker)

    await expect(wrapped()).rejects.toThrow('wrapped-fail')

    const health = breaker.getHealthInfo()
    expect(health.metrics.failedCalls).toBe(1)
  })
})

describe('DistributedCircuitBreakerClient', () => {
  it('initializes with a name and uses redis client methods', async () => {
    const client = new DistributedCircuitBreakerClient('dist-test')
    const health = await client.getHealth()
    expect(health).toBeDefined()
  })

  it('can open and close circuit via redis-backed client without throwing', async () => {
    const client = new DistributedCircuitBreakerClient('dist-test-2')

    await expect(client.open()).resolves.toBeUndefined()
    await expect(client.close()).resolves.toBeUndefined()
  })
})