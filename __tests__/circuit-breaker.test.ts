import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals'
import {
  CircuitBreaker,
  CircuitBreakerOpenError,
  CircuitState,
  DistributedCircuitBreakerClient,
  withCircuitBreaker,
} from '../src/circuit-breaker'

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

  it('starts in CLOSED state and allows requests', () => {
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

  it('records failures and opens when failureThreshold reached', async () => {
    const breaker = new CircuitBreaker('test', {
      failureThreshold: 2,
      failureRateThreshold: 1, // avoid rate opening early
    })

    const failingOp = jest.fn().mockRejectedValue(new Error('fail'))

    await expect(breaker.execute(failingOp)).rejects.toThrow('fail')
    await expect(breaker.execute(failingOp)).rejects.toThrow('fail')

    const health = breaker.getHealthInfo()
    expect(health.failureCount).toBe(2)
    expect(health.state).toBe(CircuitState.OPEN)
    expect(health.metrics.failedCalls).toBe(2)
    expect(health.metrics.stateTransitions).toBe(1)
  })

  it('opens when failureRateThreshold exceeded using sliding window', () => {
    const breaker = new CircuitBreaker('test', {
      failureThreshold: 100, // high so only rate matters
      slidingWindowSize: 4,
      failureRateThreshold: 0.5,
    })

    // 2 failures and 2 successes -> 50% failure rate, should open
    breaker.executeSync(() => {
      throw new Error('fail')
    })
    breaker.executeSync(() => {
      throw new Error('fail')
    })

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
      expect(err.message).toContain('Circuit breaker "test" is open')
    }
  })

  it('uses fallback when open', () => {
    const breaker = new CircuitBreaker('test', {
      failureThreshold: 1,
      timeoutMs: 30000,
      fallback: () => 'fallback',
    })

    try {
      breaker.executeSync(() => {
        throw new Error('fail')
      })
    } catch {
      // ignore
    }

    expect(breaker.getState()).toBe(CircuitState.OPEN)

    const result = breaker.executeSync(() => 'ok')
    expect(result).toBe('fallback')
  })

  it('moves from OPEN to HALF_OPEN after timeout and then to CLOSED on success', () => {
    const breaker = new CircuitBreaker('test', {
      failureThreshold: 1,
      timeoutMs: 10000,
    })

    try {
      breaker.executeSync(() => {
        throw new Error('fail')
      })
    } catch {
      // ignore
    }

    expect(breaker.getState()).toBe(CircuitState.OPEN)

    jest.advanceTimersByTime(10001)
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)

    const result = breaker.executeSync(() => 'ok')
    expect(result).toBe('ok')
    expect(breaker.getState()).toBe(CircuitState.CLOSED)

    const health = breaker.getHealthInfo()
    expect(health.metrics.stateTransitions).toBeGreaterThanOrEqual(2)
  })

  it('moves from HALF_OPEN back to OPEN on failure', () => {
    const breaker = new CircuitBreaker('test', {
      failureThreshold: 1,
      timeoutMs: 10000,
    })

    try {
      breaker.executeSync(() => {
        throw new Error('fail')
      })
    } catch {
      // ignore
    }

    expect(breaker.getState()).toBe(CircuitState.OPEN)

    jest.advanceTimersByTime(10001)
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

  it('tracks metrics correctly over multiple calls', async () => {
    const breaker = new CircuitBreaker('test', {
      failureThreshold: 3,
      slidingWindowSize: 10,
    })

    const successOp = jest.fn().mockResolvedValue('ok')
    const failOp = jest.fn().mockRejectedValue(new Error('fail'))

    await breaker.execute(successOp)
    await breaker.execute(successOp)
    await expect(breaker.execute(failOp)).rejects.toThrow('fail')
    await breaker.execute(successOp)

    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(4)
    expect(health.metrics.successfulCalls).toBe(3)
    expect(health.metrics.failedCalls).toBe(1)
    expect(health.failureCount).toBe(1)
    expect(health.state).toBe(CircuitState.CLOSED)
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

  it('wraps a function with a circuit breaker', async () => {
    const fn = jest.fn().mockResolvedValue('ok')
    const wrapped = withCircuitBreaker('wrapped-test', fn)

    const result = await wrapped()
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('propagates errors through the circuit breaker', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('fail'))
    const wrapped = withCircuitBreaker('wrapped-test', fn)

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

  it('creates and reuses circuit breakers per key', () => {
    const client = new DistributedCircuitBreakerClient()

    const breaker1 = client.getBreaker('service-a')
    const breaker2 = client.getBreaker('service-a')
    const breaker3 = client.getBreaker('service-b')

    expect(breaker1).toBe(breaker2)
    expect(breaker1).not.toBe(breaker3)
    expect(breaker1.getState()).toBe(CircuitState.CLOSED)
    expect(breaker3.getState()).toBe(CircuitState.CLOSED)
  })

  it('executes operations through named breakers', async () => {
    const client = new DistributedCircuitBreakerClient()
    const op = jest.fn().mockResolvedValue('ok')

    const result = await client.execute('service-a', op)
    expect(result).toBe('ok')
    expect(op).toHaveBeenCalledTimes(1)

    const breaker = client.getBreaker('service-a')
    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(1)
    expect(health.metrics.successfulCalls).toBe(1)
  })

  it('handles failures and opens breaker per key', async () => {
    const client = new DistributedCircuitBreakerClient({
      failureThreshold: 1,
      timeoutMs: 30000,
    })

    const failOp = jest.fn().mockRejectedValue(new Error('fail'))

    await expect(client.execute('service-a', failOp)).rejects.toThrow('fail')

    const breakerA = client.getBreaker('service-a')
    expect(breakerA.getState()).toBe(CircuitState.OPEN)

    const breakerB = client.getBreaker('service-b')
    expect(breakerB.getState()).toBe(CircuitState.CLOSED)
  })
})