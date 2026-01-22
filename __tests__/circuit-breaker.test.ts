import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals'
import {
  CircuitBreaker,
  CircuitBreakerOpenError,
  CircuitState,
  DistributedCircuitBreakerClient,
  withCircuitBreaker,
} from '@/app/circuit-breaker'

declare const global: any

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

  it('opens when failureRateThreshold exceeded using sliding window', () => {
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
    expect(health.state).toBe(CircuitState.OPEN)
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

    expect(breaker.getState()).toBe(CircuitState.OPEN)

    const call = () => breaker.executeSync(() => 'ok')
    expect(call).toThrow(CircuitBreakerOpenError)

    try {
      call()
    } catch (err: any) {
      expect(err).toBeInstanceOf(CircuitBreakerOpenError)
      expect(err.name).toBe('CircuitBreakerOpenError')
      expect(err.message).toContain('Circuit breaker "test" is OPEN')
    }
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

    expect(breaker.getState()).toBe(CircuitState.OPEN)

    const fallback = jest.fn().mockReturnValue('fallback')
    const result = breaker.executeSync(() => 'ok', { fallback })

    expect(result).toBe('fallback')
    expect(fallback).toHaveBeenCalledTimes(1)
  })

  it('transitions to HALF_OPEN after timeout and allows limited calls', () => {
    const breaker = new CircuitBreaker('test', {
      failureThreshold: 1,
      timeoutMs: 30000,
      halfOpenMaxCalls: 2,
    })

    try {
      breaker.executeSync(() => {
        throw new Error('fail')
      })
    } catch {
      // ignore
    }

    expect(breaker.getState()).toBe(CircuitState.OPEN)

    jest.advanceTimersByTime(30001)

    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)

    const result1 = breaker.executeSync(() => 'ok')
    const result2 = breaker.executeSync(() => 'ok')

    expect(result1).toBe('ok')
    expect(result2).toBe('ok')

    const health = breaker.getHealthInfo()
    expect(health.state).toBe(CircuitState.CLOSED)
    expect(health.metrics.successfulCalls).toBeGreaterThanOrEqual(2)
  })

  it('limits number of calls in HALF_OPEN and reopens on failure', () => {
    const breaker = new CircuitBreaker('test', {
      failureThreshold: 1,
      timeoutMs: 30000,
      halfOpenMaxCalls: 1,
    })

    try {
      breaker.executeSync(() => {
        throw new Error('fail')
      })
    } catch {
      // ignore
    }

    expect(breaker.getState()).toBe(CircuitState.OPEN)

    jest.advanceTimersByTime(30001)

    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)

    try {
      breaker.executeSync(() => {
        throw new Error('fail again')
      })
    } catch {
      // ignore
    }

    expect(breaker.getState()).toBe(CircuitState.OPEN)
  })

  it('tracks health info correctly', () => {
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
    expect(health.state).toBe(CircuitState.CLOSED)
    expect(health.metrics.totalCalls).toBe(2)
    expect(health.metrics.successfulCalls).toBe(1)
    expect(health.metrics.failedCalls).toBe(1)
    expect(health.failureCount).toBe(1)
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

  it('wraps async function with circuit breaker', async () => {
    const fn = jest.fn().mockResolvedValue('ok')
    const wrapped = withCircuitBreaker('service', fn)

    const result = await wrapped()
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('wraps sync function with circuit breaker', () => {
    const fn = jest.fn().mockReturnValue('ok')
    const wrapped = withCircuitBreaker('service', fn)

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

  it('creates and reuses breakers per service', () => {
    const client = new DistributedCircuitBreakerClient()

    const breakerA1 = client.getBreaker('serviceA')
    const breakerA2 = client.getBreaker('serviceA')
    const breakerB = client.getBreaker('serviceB')

    expect(breakerA1).toBe(breakerA2)
    expect(breakerA1).not.toBe(breakerB)
  })

  it('executes operations through named breaker', async () => {
    const client = new DistributedCircuitBreakerClient()
    const op = jest.fn().mockResolvedValue('ok')

    const result = await client.execute('serviceA', op)

    expect(result).toBe('ok')
    expect(op).toHaveBeenCalledTimes(1)
  })

  it('exposes health info for all breakers', () => {
    const client = new DistributedCircuitBreakerClient()

    client.getBreaker('serviceA').executeSync(() => 'ok')
    client.getBreaker('serviceB').executeSync(() => 'ok')

    const health = client.getHealthInfo()
    expect(health.serviceA).toBeDefined()
    expect(health.serviceB).toBeDefined()
    expect(health.serviceA.state).toBe(CircuitState.CLOSED)
    expect(health.serviceB.state).toBe(CircuitState.CLOSED)
  })
})