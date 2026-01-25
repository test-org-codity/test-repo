import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals'
import {
  CircuitBreaker,
  CircuitBreakerOpenError,
  CircuitState,
  DistributedCircuitBreakerClient,
  withCircuitBreaker,
} from './circuit-breaker.test'

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

  it('uses fallback when open and fallback is provided', async () => {
    const breaker = new CircuitBreaker('test', {
      failureThreshold: 1,
      failureRateThreshold: 1,
    })

    const failingOp = jest.fn().mockRejectedValue(new Error('fail'))

    await expect(breaker.execute(failingOp)).rejects.toThrow('fail')

    const fallback = jest.fn().mockResolvedValue('fallback')

    const result = await breaker.execute(failingOp, fallback)
    expect(result).toBe('fallback')

    const health = breaker.getHealthInfo()
    expect(health.state).toBe(CircuitState.OPEN)
    expect(health.metrics.failedCalls).toBe(1)
    expect(health.metrics.totalCalls).toBe(2)
  })

  it('does not use fallback when closed even if provided', async () => {
    const breaker = new CircuitBreaker('test')

    const op = jest.fn().mockResolvedValue('ok')
    const fallback = jest.fn().mockResolvedValue('fallback')

    const result = await breaker.execute(op, fallback)
    expect(result).toBe('ok')
    expect(fallback).not.toHaveBeenCalled()

    const health = breaker.getHealthInfo()
    expect(health.state).toBe(CircuitState.CLOSED)
    expect(health.metrics.successfulCalls).toBe(1)
    expect(health.metrics.totalCalls).toBe(1)
  })

  it('transitions to HALF_OPEN after openStateDuration and then to CLOSED on success', async () => {
    const breaker = new CircuitBreaker('test', {
      failureThreshold: 1,
      failureRateThreshold: 1,
      openStateDuration: 1000,
    })

    const failingOp = jest.fn().mockRejectedValue(new Error('fail'))

    await expect(breaker.execute(failingOp)).rejects.toThrow('fail')

    let health = breaker.getHealthInfo()
    expect(health.state).toBe(CircuitState.OPEN)

    jest.advanceTimersByTime(1000)

    health = breaker.getHealthInfo()
    expect(health.state).toBe(CircuitState.HALF_OPEN)

    const op = jest.fn().mockResolvedValue('ok')
    const result = await breaker.execute(op)
    expect(result).toBe('ok')

    health = breaker.getHealthInfo()
    expect(health.state).toBe(CircuitState.CLOSED)
  })

  it('transitions back to OPEN from HALF_OPEN on failure', async () => {
    const breaker = new CircuitBreaker('test', {
      failureThreshold: 1,
      failureRateThreshold: 1,
      openStateDuration: 1000,
    })

    const failingOp = jest.fn().mockRejectedValue(new Error('fail'))

    await expect(breaker.execute(failingOp)).rejects.toThrow('fail')

    jest.advanceTimersByTime(1000)

    const failingAgain = jest.fn().mockRejectedValue(new Error('fail again'))
    await expect(breaker.execute(failingAgain)).rejects.toThrow('fail again')

    const health = breaker.getHealthInfo()
    expect(health.state).toBe(CircuitState.OPEN)
  })

  it('throws CircuitBreakerOpenError when open and no fallback provided', async () => {
    const breaker = new CircuitBreaker('test', {
      failureThreshold: 1,
      failureRateThreshold: 1,
    })

    const failingOp = jest.fn().mockRejectedValue(new Error('fail'))

    await expect(breaker.execute(failingOp)).rejects.toThrow('fail')

    await expect(breaker.execute(failingOp)).rejects.toBeInstanceOf(
      CircuitBreakerOpenError,
    )
  })

  it('getHealthInfo returns consistent structure', () => {
    const breaker = new CircuitBreaker('test')

    const health = breaker.getHealthInfo()
    expect(health).toHaveProperty('state')
    expect(health).toHaveProperty('failureCount')
    expect(health).toHaveProperty('lastFailureTime')
    expect(health).toHaveProperty('metrics')
    expect(health.metrics).toHaveProperty('totalCalls')
    expect(health.metrics).toHaveProperty('successfulCalls')
    expect(health.metrics).toHaveProperty('failedCalls')
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

  it('wraps a function with a circuit breaker and executes successfully', async () => {
    const fn = jest.fn().mockResolvedValue('ok')
    const wrapped = withCircuitBreaker('test', fn)

    const result = await wrapped()
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('propagates errors from the wrapped function', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('fail'))
    const wrapped = withCircuitBreaker('test', fn)

    await expect(wrapped()).rejects.toThrow('fail')
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

  it('can be constructed without throwing', () => {
    const client = new DistributedCircuitBreakerClient()
    expect(client).toBeInstanceOf(DistributedCircuitBreakerClient)
  })

  it('exposes expected public methods based on implementation', () => {
    const client = new DistributedCircuitBreakerClient()
    expect(typeof (client as any).execute).toBe('function')
  })
})