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

    jest.advanceTimersByTime(1001)

    const successOp = jest.fn().mockResolvedValue('ok')
    const result = await breaker.execute(successOp)
    expect(result).toBe('ok')

    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(2)
    expect(health.metrics.successfulCalls).toBe(1)
    expect(health.metrics.failedCalls).toBe(1)
  })

  it('throws CircuitBreakerOpenError when open and no fallback is provided', async () => {
    const breaker = new CircuitBreaker('test', {
      failureThreshold: 1,
      failureRateThreshold: 1,
    })

    const failingOp = jest.fn().mockRejectedValue(new Error('fail'))
    await expect(breaker.execute(failingOp)).rejects.toThrow('fail')

    await expect(
      breaker.execute(jest.fn().mockResolvedValue('ok')),
    ).rejects.toBeInstanceOf(CircuitBreakerOpenError)
  })

  it('calls fallback when provided and circuit is open', async () => {
    const breaker = new CircuitBreaker('test', {
      failureThreshold: 1,
      failureRateThreshold: 1,
    })

    const failingOp = jest.fn().mockRejectedValue(new Error('fail'))
    await expect(breaker.execute(failingOp)).rejects.toThrow('fail')

    const fallback = jest.fn().mockResolvedValue('fallback')
    const result = await breaker.execute(jest.fn(), { fallback })

    expect(result).toBe('fallback')
    expect(fallback).toHaveBeenCalled()
  })

  it('withCircuitBreaker wraps a function and uses the underlying breaker', async () => {
    const breaker = new CircuitBreaker('wrapped')
    const fn = jest.fn().mockResolvedValue('ok')

    const wrapped = withCircuitBreaker(breaker, fn)
    const result = await wrapped()

    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)

    const health = breaker.getHealthInfo()
    expect(health.metrics.successfulCalls).toBe(1)
  })
})

describe('DistributedCircuitBreakerClient', () => {
  it('creates a breaker and executes operations', async () => {
    const client = new DistributedCircuitBreakerClient('test-service')
    const op = jest.fn().mockResolvedValue('ok')

    const result = await client.execute('resource-1', op)

    expect(result).toBe('ok')
    expect(op).toHaveBeenCalledTimes(1)
  })

  it('propagates errors from the underlying operation', async () => {
    const client = new DistributedCircuitBreakerClient('test-service')
    const op = jest.fn().mockRejectedValue(new Error('network'))

    await expect(client.execute('resource-1', op)).rejects.toThrow('network')
  })

  it('supports sync execution via executeSync', () => {
    const client = new DistributedCircuitBreakerClient('test-service')
    const op = jest.fn().mockReturnValue('ok')

    const result = client.executeSync('resource-1', op)

    expect(result).toBe('ok')
    expect(op).toHaveBeenCalledTimes(1)
  })
})