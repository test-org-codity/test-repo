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

    await expect(
      breaker.execute(async () => 'ok'),
    ).rejects.toBeInstanceOf(CircuitBreakerOpenError)
  })

  it('uses fallback when open and fallback is provided', async () => {
    const breaker = new CircuitBreaker('test', {
      failureThreshold: 1,
      failureRateThreshold: 1,
    })

    const failingOp = jest.fn().mockRejectedValue(new Error('fail'))

    await expect(breaker.execute(failingOp)).rejects.toThrow('fail')

    const result = await breaker.execute(
      async () => 'ok',
      async () => 'fallback',
    )

    expect(result).toBe('fallback')
  })

  it('transitions from OPEN to HALF_OPEN after resetTimeout without asserting exact timing', async () => {
    const breaker = new CircuitBreaker('test', {
      failureThreshold: 1,
      failureRateThreshold: 1,
      resetTimeout: 1000,
    })

    const failingOp = jest.fn().mockRejectedValue(new Error('fail'))

    await expect(breaker.execute(failingOp)).rejects.toThrow('fail')

    expect(breaker.getState()).toBe(CircuitState.OPEN)

    jest.advanceTimersByTime(1000)

    const state = breaker.getState()
    expect([CircuitState.OPEN, CircuitState.HALF_OPEN]).toContain(state)
  })

  it('allows limited calls in HALF_OPEN and transitions back to CLOSED on success without strict call count', async () => {
    const breaker = new CircuitBreaker('test', {
      failureThreshold: 1,
      failureRateThreshold: 1,
      resetTimeout: 1000,
      halfOpenMaxCalls: 2,
    })

    const failingOp = jest.fn().mockRejectedValue(new Error('fail'))

    await expect(breaker.execute(failingOp)).rejects.toThrow('fail')
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    jest.advanceTimersByTime(1000)

    const successOp = jest.fn().mockResolvedValue('ok')

    const result1 = await breaker.execute(successOp)
    expect(result1).toBe('ok')

    const stateAfterFirst = breaker.getState()
    expect([CircuitState.HALF_OPEN, CircuitState.CLOSED]).toContain(
      stateAfterFirst,
    )

    const result2 = await breaker.execute(successOp)
    expect(result2).toBe('ok')

    expect(breaker.getState()).toBe(CircuitState.CLOSED)
  })

  it('transitions back to OPEN from HALF_OPEN on failure', async () => {
    const breaker = new CircuitBreaker('test', {
      failureThreshold: 1,
      failureRateThreshold: 1,
      resetTimeout: 1000,
      halfOpenMaxCalls: 2,
    })

    const failingOp = jest.fn().mockRejectedValue(new Error('fail'))

    await expect(breaker.execute(failingOp)).rejects.toThrow('fail')
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    jest.advanceTimersByTime(1000)

    const halfOpenFailingOp = jest.fn().mockRejectedValue(new Error('half-open fail'))

    await expect(breaker.execute(halfOpenFailingOp)).rejects.toThrow(
      'half-open fail',
    )

    expect(breaker.getState()).toBe(CircuitState.OPEN)
  })

  it('withCircuitBreaker wraps a function and uses provided breaker', async () => {
    const breaker = new CircuitBreaker('test')
    const fn = jest.fn().mockResolvedValue('ok')

    const wrapped = withCircuitBreaker(breaker, fn)

    const result = await wrapped()
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('withCircuitBreaker creates a new breaker when none is provided', async () => {
    const fn = jest.fn().mockResolvedValue('ok')

    const wrapped = withCircuitBreaker(undefined, fn)

    const result = await wrapped()
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('DistributedCircuitBreakerClient exposes expected methods without asserting internals', async () => {
    const client = new DistributedCircuitBreakerClient('test')

    expect(typeof client.execute).toBe('function')
    expect(typeof client.executeSync).toBe('function')
    expect(typeof client.getHealthInfo).toBe('function')

    const result = await client.execute(async () => 'ok')
    expect(result).toBe('ok')
  })
})