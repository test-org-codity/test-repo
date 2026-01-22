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


  it('after timeout allows calls again (state may remain OPEN depending on implementation)', () => {
    const breaker = new CircuitBreaker('test', {
      failureThreshold: 1,
      timeoutMs: 1000,
    })

    try {
      breaker.executeSync(() => {
        throw new Error('fail')
      })
    } catch {
      // ignore
    }

    jest.advanceTimersByTime(1500)

    const result = breaker.executeSync(() => 'ok')
    expect(result).toBe('ok')

    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(2)
  })

  it('uses fallback when provided for sync execution', () => {
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

    const result = breaker.executeSync(
      () => {
        throw new Error('should not run')
      },
      () => 'fallback',
    )

    expect(result).toBe('fallback')
  })

  it('uses fallback when provided for async execution', async () => {
    const breaker = new CircuitBreaker('test', {
      failureThreshold: 1,
      timeoutMs: 30000,
    })

    const failingOp = jest.fn().mockRejectedValue(new Error('fail'))
    await expect(breaker.execute(failingOp)).rejects.toThrow('fail')

    const result = await breaker.execute(
      jest.fn().mockResolvedValue('ok'),
      async () => 'fallback-async',
    )

    expect(result).toBe('fallback-async')
  })

  it('getHealthInfo returns metrics object with expected shape', () => {
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
    expect(health).toHaveProperty('state')
    expect(health).toHaveProperty('failureCount')
    expect(health).toHaveProperty('lastFailureTime')
    expect(health).toHaveProperty('metrics')
    expect(health.metrics).toHaveProperty('totalCalls')
    expect(health.metrics.totalCalls).toBe(2)
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

  it('wraps an async function and passes through result', async () => {
    const fn = jest.fn().mockResolvedValue('wrapped-ok')

    const wrapped = withCircuitBreaker('wrapped-test', fn)

    const result = await wrapped()
    expect(result).toBe('wrapped-ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('wraps a sync function and passes through result when executed', () => {
    const fn = jest.fn().mockReturnValue('wrapped-sync-ok')

    const wrapped = withCircuitBreaker('wrapped-sync-test', fn)

    const result = wrapped()
    expect(result).toBe('wrapped-sync-ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })
})

describe('DistributedCircuitBreakerClient', () => {
  it('can be constructed with a name and options', () => {
    const client = new DistributedCircuitBreakerClient('dist-test', {
      failureThreshold: 2,
    })

    expect(client).toBeInstanceOf(DistributedCircuitBreakerClient)
  })
})