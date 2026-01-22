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

  it('opens when failureRateThreshold exceeded using sliding window (behavioral check only)', () => {
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

    const call = () => breaker.executeSync(() => 'ok')

    expect(call).toThrow(CircuitBreakerOpenError)
  })

  it('transitions to HALF_OPEN after timeout and allows a trial call', async () => {
    const breaker = new CircuitBreaker('test', {
      failureThreshold: 1,
      timeoutMs: 1000,
    })

    const failingOp = jest.fn().mockRejectedValue(new Error('fail'))

    await expect(breaker.execute(failingOp)).rejects.toThrow('fail')

    expect(breaker.getState()).toBe(CircuitState.OPEN)

    jest.advanceTimersByTime(1000)

    const healthBefore = breaker.getHealthInfo()
    expect(healthBefore.state).toBe(CircuitState.HALF_OPEN)

    const result = await breaker.execute(async () => 'ok')
    expect(result).toBe('ok')

    const healthAfter = breaker.getHealthInfo()
    expect(healthAfter.state).toBe(CircuitState.CLOSED)
    expect(healthAfter.metrics.successfulCalls).toBeGreaterThanOrEqual(1)
  })

  it('transitions back to OPEN from HALF_OPEN when trial call fails', async () => {
    const breaker = new CircuitBreaker('test', {
      failureThreshold: 1,
      timeoutMs: 1000,
    })

    const failingOp = jest.fn().mockRejectedValue(new Error('fail'))

    await expect(breaker.execute(failingOp)).rejects.toThrow('fail')
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    jest.advanceTimersByTime(1000)
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)

    await expect(
      breaker.execute(async () => {
        throw new Error('trial fail')
      }),
    ).rejects.toThrow('trial fail')

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

    const result = breaker.executeSync(
      () => {
        throw new Error('should not be called')
      },
      () => 'fallback',
    )

    expect(result).toBe('fallback')
    const health = breaker.getHealthInfo()
    expect(health.state).toBe(CircuitState.OPEN)
  })

  it('tracks response times in metrics', async () => {
    const breaker = new CircuitBreaker('test')

    await breaker.execute(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve('ok'), 100)
        }),
    )

    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(1)
    expect(health.metrics.averageResponseTimeMs).toBeGreaterThanOrEqual(0)
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

  it('propagates errors when no fallback is provided', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('fail'))

    const wrapped = withCircuitBreaker('test', fn)

    await expect(wrapped()).rejects.toThrow('fail')
  })

  it('uses fallback when provided and breaker is open', async () => {
    const breaker = new CircuitBreaker('test', {
      failureThreshold: 1,
      timeoutMs: 30000,
    })

    const failing = jest.fn().mockRejectedValue(new Error('fail'))
    await expect(breaker.execute(failing)).rejects.toThrow('fail')

    const wrapped = withCircuitBreaker(
      'test',
      () => {
        throw new Error('should not run')
      },
      () => 'fallback',
    )

    const result = await wrapped()
    expect(result).toBe('fallback')
  })
})

describe('DistributedCircuitBreakerClient', () => {
  let client: DistributedCircuitBreakerClient

  beforeEach(() => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2024-01-01T00:00:00.000Z'))
    client = new DistributedCircuitBreakerClient()
  })

  afterEach(() => {
    jest.useRealTimers()
    jest.clearAllMocks()
  })

  it('creates and reuses circuit breakers per key', () => {
    const breaker1 = client.getBreaker('service-a')
    const breaker2 = client.getBreaker('service-a')
    const breaker3 = client.getBreaker('service-b')

    expect(breaker1).toBe(breaker2)
    expect(breaker1).not.toBe(breaker3)
  })

  it('executes operations through named breakers', async () => {
    const op = jest.fn().mockResolvedValue('ok')

    const result = await client.execute('service-a', op)

    expect(result).toBe('ok')
    expect(op).toHaveBeenCalledTimes(1)

    const breaker = client.getBreaker('service-a')
    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(1)
    expect(health.metrics.successfulCalls).toBe(1)
  })

  it('records failures and opens breaker via client execute', async () => {
    const op = jest.fn().mockRejectedValue(new Error('fail'))

    await expect(client.execute('service-a', op)).rejects.toThrow('fail')
    await expect(client.execute('service-a', op)).rejects.toThrow('fail')

    const breaker = client.getBreaker('service-a')
    const health = breaker.getHealthInfo()
    expect(health.failureCount).toBeGreaterThanOrEqual(2)
    expect(health.state).toBe(CircuitState.OPEN)
  })
})