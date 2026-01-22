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

  it('supports fallback when open', () => {
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

    const result = breaker.executeSync(
      () => 'should not run',
      () => 'fallback'
    )

    expect(result).toBe('fallback')
  })

  it('execute handles successful async operations', async () => {
    const breaker = new CircuitBreaker('test')

    const op = jest.fn().mockResolvedValue('async-ok')

    const result = await breaker.execute(op)
    expect(result).toBe('async-ok')

    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(1)
    expect(health.metrics.successfulCalls).toBe(1)
  })

  it('execute uses async fallback when open', async () => {
    const breaker = new CircuitBreaker('test', {
      failureThreshold: 1,
      timeoutMs: 30000,
    })

    const failingOp = jest.fn().mockRejectedValue(new Error('fail'))
    await expect(breaker.execute(failingOp)).rejects.toThrow('fail')

    expect(breaker.getState()).toBe(CircuitState.OPEN)

    const op = jest.fn().mockResolvedValue('should-not-run')
    const fallback = jest.fn().mockResolvedValue('async-fallback')

    const result = await breaker.execute(op, fallback)
    expect(result).toBe('async-fallback')
    expect(op).not.toHaveBeenCalled()
    expect(fallback).toHaveBeenCalledTimes(1)
  })
})

describe('withCircuitBreaker', () => {
  it('wraps a function and uses CircuitBreaker for sync calls', () => {
    const breaker = new CircuitBreaker('wrapped')
    const fn = (x: number) => x * 2

    const wrapped = withCircuitBreaker(breaker, fn)

    const result = wrapped(3)
    expect(result).toBe(6)

    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(1)
    expect(health.metrics.successfulCalls).toBe(1)
  })

  it('wraps an async function and uses CircuitBreaker', async () => {
    const breaker = new CircuitBreaker('wrapped-async')
    const fn = jest.fn().mockResolvedValue('wrapped-ok')

    const wrapped = withCircuitBreaker(breaker, fn)

    const result = await wrapped()
    expect(result).toBe('wrapped-ok')

    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(1)
    expect(health.metrics.successfulCalls).toBe(1)
  })
})

describe('DistributedCircuitBreakerClient', () => {
  const mockRedis = () => {
    const actual = jest.requireActual('redis-mock')
    return {
      ...actual,
      createClient: jest.fn(() => {
        const store: Record<string, string> = {}
        return {
          get: jest.fn(async (key: string) => store[key] ?? null),
          set: jest.fn(async (key: string, value: string) => {
            store[key] = value
          }),
          on: jest.fn(),
          connect: jest.fn(),
          quit: jest.fn(),
        }
      }),
    }
  }

  jest.mock('redis', () => mockRedis())

  it('creates a distributed breaker and tracks state via storage', async () => {
    const storage = {
      getState: jest.fn().mockResolvedValue(CircuitState.CLOSED),
      setState: jest.fn().mockResolvedValue(undefined),
      getFailureCount: jest.fn().mockResolvedValue(0),
      incrementFailureCount: jest.fn().mockResolvedValue(1),
      resetFailureCount: jest.fn().mockResolvedValue(undefined),
    }

    const client = new DistributedCircuitBreakerClient('dist-test', storage, {
      failureThreshold: 1,
      timeoutMs: 10000,
    })

    const op = jest.fn().mockRejectedValue(new Error('dist-fail'))

    await expect(client.execute(op)).rejects.toThrow('dist-fail')
    expect(storage.incrementFailureCount).toHaveBeenCalled()

    storage.getState.mockResolvedValueOnce(CircuitState.OPEN)

    const fallback = jest.fn().mockResolvedValue('dist-fallback')
    const result = await client.execute(op, fallback)

    expect(result).toBe('dist-fallback')
    expect(fallback).toHaveBeenCalled()
  })
})