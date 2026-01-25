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


  it('uses fallback when open and fallback is provided', async () => {
    const breaker = new CircuitBreaker('test', {
      failureThreshold: 1,
      failureRateThreshold: 1,
    })

    const failingOp = jest.fn().mockRejectedValue(new Error('fail'))

    await expect(breaker.execute(failingOp)).rejects.toThrow('fail')

    const healthAfterFailure = breaker.getHealthInfo()
    expect(healthAfterFailure.state).toBe(CircuitState.OPEN)

    const op = jest.fn().mockResolvedValue('ok')
    const fallback = jest.fn().mockResolvedValue('fallback')

    const result = await breaker.execute(op, fallback)

    expect(result).toBe('fallback')
    expect(op).not.toHaveBeenCalled()
    expect(fallback).toHaveBeenCalledTimes(1)
  })

  it('allows sync fallback when open', () => {
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

    const healthAfterFailure = breaker.getHealthInfo()
    expect(healthAfterFailure.state).toBe(CircuitState.OPEN)

    const op = jest.fn().mockReturnValue('ok')
    const fallback = jest.fn().mockReturnValue('fallback')

    const result = breaker.executeSync(op, fallback)

    expect(result).toBe('fallback')
    expect(op).not.toHaveBeenCalled()
    expect(fallback).toHaveBeenCalledTimes(1)
  })

  it('resets failure count and metrics on successful call in HALF_OPEN', async () => {
    const breaker = new CircuitBreaker('test', {
      failureThreshold: 1,
      failureRateThreshold: 1,
      halfOpenAfter: 1000,
    })

    const failingOp = jest.fn().mockRejectedValue(new Error('fail'))

    await expect(breaker.execute(failingOp)).rejects.toThrow('fail')

    const healthAfterFailure = breaker.getHealthInfo()
    expect(healthAfterFailure.state).toBe(CircuitState.OPEN)

    jest.advanceTimersByTime(1000)

    const successOp = jest.fn().mockResolvedValue('ok')
    const result = await breaker.execute(successOp)

    expect(result).toBe('ok')

    const healthAfterSuccess = breaker.getHealthInfo()
    expect(healthAfterSuccess.state).toBe(CircuitState.CLOSED)
    expect(healthAfterSuccess.failureCount).toBe(0)
    expect(healthAfterSuccess.metrics.failedCalls).toBe(1)
    expect(healthAfterSuccess.metrics.successfulCalls).toBe(1)
    expect(healthAfterSuccess.metrics.totalCalls).toBe(2)
  })

  it('increments failure count and reopens on failure in HALF_OPEN', async () => {
    const breaker = new CircuitBreaker('test', {
      failureThreshold: 1,
      failureRateThreshold: 1,
      halfOpenAfter: 1000,
    })

    const failingOp = jest.fn().mockRejectedValue(new Error('fail'))

    await expect(breaker.execute(failingOp)).rejects.toThrow('fail')

    const healthAfterFailure = breaker.getHealthInfo()
    expect(healthAfterFailure.state).toBe(CircuitState.OPEN)

    jest.advanceTimersByTime(1000)

    const halfOpenFailingOp = jest.fn().mockRejectedValue(new Error('half-open fail'))

    await expect(breaker.execute(halfOpenFailingOp)).rejects.toThrow('half-open fail')

    const healthAfterHalfOpenFailure = breaker.getHealthInfo()
    expect(healthAfterHalfOpenFailure.state).toBe(CircuitState.OPEN)
    expect(healthAfterHalfOpenFailure.failureCount).toBe(2)
    expect(healthAfterHalfOpenFailure.metrics.failedCalls).toBe(2)
    expect(healthAfterHalfOpenFailure.metrics.totalCalls).toBe(2)
  })

  it('executeSync propagates error when CLOSED and no fallback', () => {
    const breaker = new CircuitBreaker('test')

    const op = jest.fn(() => {
      throw new Error('boom')
    })

    expect(() => breaker.executeSync(op)).toThrow('boom')

    const health = breaker.getHealthInfo()
    expect(health.state).toBe(CircuitState.CLOSED)
    expect(health.metrics.failedCalls).toBe(1)
    expect(health.metrics.totalCalls).toBe(1)
  })

  it('execute propagates error when CLOSED and no fallback', async () => {
    const breaker = new CircuitBreaker('test')

    const op = jest.fn().mockRejectedValue(new Error('boom'))

    await expect(breaker.execute(op)).rejects.toThrow('boom')

    const health = breaker.getHealthInfo()
    expect(health.state).toBe(CircuitState.CLOSED)
    expect(health.metrics.failedCalls).toBe(1)
    expect(health.metrics.totalCalls).toBe(1)
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

  it('wraps an async function and uses a named breaker', async () => {
    const fn = jest.fn().mockResolvedValue('ok')

    const wrapped = withCircuitBreaker('wrapped-test', fn)

    const result = await wrapped()

    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('wraps a sync function and uses a named breaker', () => {
    const fn = jest.fn().mockReturnValue('ok')

    const wrapped = withCircuitBreaker('wrapped-sync-test', fn)

    const result = wrapped()

    expect(result).toBe('ok')
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

  it('can be constructed with a name and options', async () => {
    const client = new DistributedCircuitBreakerClient('dist-test', {
      failureThreshold: 2,
      failureRateThreshold: 0.5,
    })

    expect(client).toBeInstanceOf(DistributedCircuitBreakerClient)
  })

  it('executes an async operation via execute', async () => {
    const client = new DistributedCircuitBreakerClient('dist-test')

    const op = jest.fn().mockResolvedValue('ok')

    const result = await client.execute(op)

    expect(result).toBe('ok')
    expect(op).toHaveBeenCalledTimes(1)
  })

  it('executes a sync operation via executeSync', () => {
    const client = new DistributedCircuitBreakerClient('dist-test')

    const op = jest.fn().mockReturnValue('ok')

    const result = client.executeSync(op)

    expect(result).toBe('ok')
    expect(op).toHaveBeenCalledTimes(1)
  })
})