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
      expect(err.message).toContain('Circuit breaker "test" is OPEN')
    }
  })

  it('uses fallback when open if provided', () => {
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

  it('transitions from OPEN to HALF_OPEN after timeout', () => {
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
  })

  it('closes again after successful HALF_OPEN trial', () => {
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

    const result = breaker.executeSync(() => 'ok')
    expect(result).toBe('ok')
    expect(breaker.getState()).toBe(CircuitState.CLOSED)

    const health = breaker.getHealthInfo()
    expect(health.metrics.stateTransitions).toBeGreaterThanOrEqual(2)
  })

  it('reopens if HALF_OPEN trial fails', () => {
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

    try {
      breaker.executeSync(() => {
        throw new Error('fail again')
      })
    } catch {
      // ignore
    }

    expect(breaker.getState()).toBe(CircuitState.OPEN)
  })

  it('tracks metrics correctly for sync and async operations', async () => {
    const breaker = new CircuitBreaker('test')

    breaker.executeSync(() => 'ok')
    await breaker.execute(async () => 'ok-async')

    try {
      breaker.executeSync(() => {
        throw new Error('fail-sync')
      })
    } catch {
      // ignore
    }

    await expect(
      breaker.execute(async () => {
        throw new Error('fail-async')
      }),
    ).rejects.toThrow('fail-async')

    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(4)
    expect(health.metrics.successfulCalls).toBe(2)
    expect(health.metrics.failedCalls).toBe(2)
  })

  it('supports custom error filter to ignore certain errors', () => {
    const breaker = new CircuitBreaker('test', {
      failureThreshold: 1,
      errorFilter: (err) => err && (err as Error).message === 'ignore-me',
    })

    try {
      breaker.executeSync(() => {
        throw new Error('ignore-me')
      })
    } catch {
      // ignore
    }

    expect(breaker.getState()).toBe(CircuitState.CLOSED)

    const health = breaker.getHealthInfo()
    expect(health.failureCount).toBe(0)
  })

  it('respects minimum number of calls before applying failure rate', () => {
    const breaker = new CircuitBreaker('test', {
      failureThreshold: 100,
      slidingWindowSize: 10,
      failureRateThreshold: 0.5,
      minimumNumberOfCalls: 5,
    })

    breaker.executeSync(() => {
      throw new Error('fail')
    })
    breaker.executeSync(() => {
      throw new Error('fail')
    })
    breaker.executeSync(() => 'ok')
    breaker.executeSync(() => 'ok')

    expect(breaker.getState()).toBe(CircuitState.CLOSED)

    breaker.executeSync(() => {
      throw new Error('fail')
    })

    expect(breaker.getState()).toBe(CircuitState.OPEN)
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

  it('reuses the same breaker for the same name', async () => {
    const fn1 = jest.fn().mockResolvedValue('one')
    const fn2 = jest.fn().mockResolvedValue('two')

    const wrapped1 = withCircuitBreaker('same-name', fn1)
    const wrapped2 = withCircuitBreaker('same-name', fn2)

    await wrapped1()
    await wrapped2()

    expect(fn1).toHaveBeenCalledTimes(1)
    expect(fn2).toHaveBeenCalledTimes(1)
  })
})

describe('DistributedCircuitBreakerClient', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2024-01-01T00:00:00.000Z'))
    global.fetch = jest.fn()
  })

  afterEach(() => {
    jest.useRealTimers()
    jest.clearAllMocks()
  })

  it('creates a client with given base URL', () => {
    const client = new DistributedCircuitBreakerClient('http://localhost:3000')
    expect(client).toBeDefined()
  })

  it('checks permission via canProceed', async () => {
    ;(global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ allowed: true }),
    })

    const client = new DistributedCircuitBreakerClient('http://localhost:3000')
    const allowed = await client.canProceed('test-service')

    expect(allowed).toBe(true)
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  it('records result via recordResult', async () => {
    ;(global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({}),
    })

    const client = new DistributedCircuitBreakerClient('http://localhost:3000')
    await client.recordResult('test-service', true)

    expect(global.fetch).toHaveBeenCalledTimes(1)
  })
})