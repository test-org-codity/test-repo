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

    const start = Date.now()
    const call = () => breaker.executeSync(() => 'ok')
    expect(call).toThrow(CircuitBreakerOpenError)

    try {
      call()
    } catch (err: any) {
      expect(err).toBeInstanceOf(CircuitBreakerOpenError)
      expect(err.name).toBe('CircuitBreakerOpenError')
      const remaining = 30000 - (Date.now() - start)
      expect(err.remainingTimeMs).toBeGreaterThanOrEqual(0)
      expect(err.remainingTimeMs).toBeLessThanOrEqual(remaining)
      expect(err.message).toContain("Circuit breaker 'test' is open.")
    }
  })

  it('uses fallback when open and fallback provided (async)', async () => {
    const breaker = new CircuitBreaker('test', {
      failureThreshold: 1,
      timeoutMs: 30000,
    })

    await expect(
      breaker.execute(async () => {
        throw new Error('fail')
      })
    ).rejects.toThrow('fail')

    expect(breaker.getState()).toBe(CircuitState.OPEN)

    const fallback = jest.fn().mockResolvedValue('fallback')
    const result = await breaker.execute(
      async () => 'should-not-run',
      fallback
    )

    expect(result).toBe('fallback')
    expect(fallback).toHaveBeenCalledTimes(1)

    const health = breaker.getHealthInfo()
    expect(health.metrics.rejectedCalls).toBe(1)
  })

  it('uses fallback when open and fallback provided (sync)', () => {
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

    const fallback = jest.fn().mockReturnValue('fallback-sync')
    const result = breaker.executeSync(
      () => 'should-not-run',
      fallback
    )

    expect(result).toBe('fallback-sync')
    expect(fallback).toHaveBeenCalledTimes(1)

    const health = breaker.getHealthInfo()
    expect(health.metrics.rejectedCalls).toBe(1)
  })

  it('transitions from OPEN to HALF_OPEN after timeout and limits half-open calls', () => {
    const breaker = new CircuitBreaker('test', {
      failureThreshold: 1,
      timeoutMs: 1000,
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

    jest.advanceTimersByTime(1000)
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)

    const op = jest.fn().mockReturnValue('ok')
    const res1 = breaker.executeSync(op)
    const res2 = breaker.executeSync(op)
    expect(res1).toBe('ok')
    expect(res2).toBe('ok')

    const call3 = () => breaker.executeSync(op)
    expect(call3).toThrow(CircuitBreakerOpenError)

    const health = breaker.getHealthInfo()
    expect(health.state).toBe(CircuitState.HALF_OPEN)
    expect(health.metrics.rejectedCalls).toBe(1)
  })

  it('closes from HALF_OPEN after enough successes', () => {
    const breaker = new CircuitBreaker('test', {
      failureThreshold: 1,
      timeoutMs: 1000,
      halfOpenMaxCalls: 5,
      successThreshold: 2,
    })

    try {
      breaker.executeSync(() => {
        throw new Error('fail')
      })
    } catch {
      // ignore
    }

    expect(breaker.getState()).toBe(CircuitState.OPEN)

    jest.advanceTimersByTime(1000)
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)

    breaker.executeSync(() => 'ok')
    expect(breaker.getHealthInfo().state).toBe(CircuitState.HALF_OPEN)

    breaker.executeSync(() => 'ok')
    expect(breaker.getHealthInfo().state).toBe(CircuitState.CLOSED)
  })

  it('re-opens from HALF_OPEN on failure', () => {
    const breaker = new CircuitBreaker('test', {
      failureThreshold: 1,
      timeoutMs: 1000,
      halfOpenMaxCalls: 5,
      successThreshold: 2,
    })

    try {
      breaker.executeSync(() => {
        throw new Error('fail')
      })
    } catch {
      // ignore
    }

    jest.advanceTimersByTime(1000)
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)

    expect(() =>
      breaker.executeSync(() => {
        throw new Error('half-open-fail')
      })
    ).toThrow('half-open-fail')

    expect(breaker.getState()).toBe(CircuitState.OPEN)
  })

  it('getOrCreate returns same instance for same name and stores in registry', () => {
    const b1 = CircuitBreaker.getOrCreate('service-a', { failureThreshold: 2 })
    const b2 = CircuitBreaker.getOrCreate('service-a', { failureThreshold: 10 })
    const b3 = CircuitBreaker.getOrCreate('service-b')

    expect(b1).toBe(b2)
    expect(b1).not.toBe(b3)

    const registry = CircuitBreaker.getRegistry()
    expect(registry.get('service-a')).toBe(b1)
    expect(registry.get('service-b')).toBe(b3)
  })

  it('health info exposes partial config and metrics snapshot', () => {
    const breaker = new CircuitBreaker('test', {
      failureThreshold: 7,
      successThreshold: 4,
      timeoutMs: 12345,
    })

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
    expect(health.config.failureThreshold).toBe(7)
    expect(health.config.successThreshold).toBe(4)
    expect(health.config.timeoutMs).toBe(12345)
    expect(health.metrics.totalCalls).toBe(2)
    expect(health.metrics.successfulCalls).toBe(1)
    expect(health.metrics.failedCalls).toBe(1)
    expect(health.metrics.averageResponseTimeMs).toBeGreaterThanOrEqual(0)
    expect(health.metrics.lastSuccessTime).toBeInstanceOf(Date)
    expect(health.metrics.lastFailureTime).toBeInstanceOf(Date)
  })

  it('averageResponseTimeMs is computed from recent response times with cap', () => {
    const breaker = new CircuitBreaker('test')

    const durations: number[] = []
    const originalNow = Date.now
    let currentTime = 0
    ;(Date as any).now = jest.fn(() => currentTime)

    for (let i = 0; i < 120; i++) {
      const start = currentTime
      currentTime = start + (i + 1)
      durations.push(currentTime - start)
      breaker.executeSync(() => 'ok')
    }

    ;(Date as any).now = originalNow

    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(120)
    expect(health.metrics.successfulCalls).toBe(120)
    expect(health.metrics.averageResponseTimeMs).toBeGreaterThan(0)
  })
})

describe('DistributedCircuitBreakerClient', () => {
  let originalFetch: any

  beforeEach(() => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2024-01-01T00:00:00.000Z'))
    originalFetch = global.fetch
    global.fetch = jest.fn()
  })

  afterEach(() => {
    jest.useRealTimers()
    jest.clearAllMocks()
    global.fetch = originalFetch
  })

  it('register sends registration payload with breaker config', async () => {
    const fetchMock = global.fetch as jest.Mock
    fetchMock.mockResolvedValue({ ok: true })

    const client = new DistributedCircuitBreakerClient('http://coordinator')
    const breaker = new CircuitBreaker('service-x', {
      failureThreshold: 9,
      successThreshold: 4,
    })

    client.register(breaker)

    await Promise.resolve()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, options] = fetchMock.mock.calls[0]
    expect(url).toBe('http://coordinator/circuit-breakers/register')
    expect(options.method).toBe('POST')
    const body = JSON.parse(options.body)
    expect(body.service).toBe('service-x')
    expect(body.failure_threshold).toBe(9)
    expect(body.success_threshold).toBe(4)
    expect(body.node_id).toBeDefined()
  })

  it('startSync sets interval and synchronizeStates reports state', async () => {
    const fetchMock = global.fetch as jest.Mock
    fetchMock.mockResolvedValue({ ok: true })

    const client = new DistributedCircuitBreakerClient('http://coordinator', 1000)
    const breaker = new CircuitBreaker('service-y')
    client.register(breaker)

    client.startSync()
    jest.advanceTimersByTime(1000)

    await Promise.resolve()

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [url, options] = fetchMock.mock.calls[1]
    expect(url).toBe('http://coordinator/circuit-breakers/state')
    expect(options.method).toBe('POST')
    const body = JSON.parse(options.body)
    expect(body.service).toBe('service-y')
    expect(body.state).toBe(CircuitState.CLOSED)
    expect(body.health_info.name).toBe('service-y')
    expect(typeof body.timestamp).toBe('number')
  })

  it('stopSync clears interval and prevents further syncs', async () => {
    const fetchMock = global.fetch as jest.Mock
    fetchMock.mockResolvedValue({ ok: true })

    const client = new DistributedCircuitBreakerClient('http://coordinator', 1000)
    const breaker = new CircuitBreaker('service-z')
    client.register(breaker)

    client.startSync()
    jest.advanceTimersByTime(1000)
    await Promise.resolve()

    client.stopSync()
    jest.advanceTimersByTime(5000)
    await Promise.resolve()

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('getAggregatedState returns remote data on success', async () => {
    const fetchMock = global.fetch as jest.Mock
    const aggregated = {
      service: 'svc',
      consensusState: CircuitState.OPEN,
      totalNodes: 3,
      healthScore: 0.7,
      nodeStates: { a: CircuitState.CLOSED, b: CircuitState.OPEN },
    }
    fetchMock.mockResolvedValue({
      json: jest.fn().mockResolvedValue(aggregated),
    })

    const client = new DistributedCircuitBreakerClient('http://coordinator')
    const result = await client.getAggregatedState('svc')

    expect(fetchMock).toHaveBeenCalledWith(
      'http://coordinator/circuit-breakers/svc/aggregate'
    )
    expect(result).toEqual(aggregated)
  })

  it('getAggregatedState returns default CLOSED state on error', async () => {
    const fetchMock = global.fetch as jest.Mock
    fetchMock.mockRejectedValue(new Error('network'))

    const client = new DistributedCircuitBreakerClient('http://coordinator')
    const result = await client.getAggregatedState('svc2')

    expect(result.service).toBe('svc2')
    expect(result.consensusState).toBe(CircuitState.CLOSED)
    expect(result.totalNodes).toBe(0)
    expect(result.healthScore).toBe(0)
    expect(result.nodeStates).toEqual({})
  })
})

describe('withCircuitBreaker decorator', () => {
  afterEach(() => {
    jest.clearAllMocks()
  })

  it('wraps method with circuit breaker execute', async () => {
    class TestService {
      public calls: any[] = []

      @withCircuitBreaker('decorated-service', {
        failureThreshold: 2,
      })
      async doWork(arg: string): Promise<string> {
        this.calls.push(arg)
        return `result-${arg}`
      }
    }

    const svc = new TestService()
    const res1 = await svc.doWork('a')
    const res2 = await svc.doWork('b')

    expect(res1).toBe('result-a')
    expect(res2).toBe('result-b')
    expect(svc.calls).toEqual(['a', 'b'])

    const breaker = CircuitBreaker.getOrCreate('decorated-service')
    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(2)
    expect(health.metrics.successfulCalls).toBe(2)
  })

  it('decorated method respects circuit breaker open state', async () => {
    class FailingService {
      @withCircuitBreaker('failing-service', {
        failureThreshold: 1,
        timeoutMs: 60000,
      })
      async doWork(): Promise<string> {
        throw new Error('boom')
      }
    }

    const svc = new FailingService()

    await expect(svc.doWork()).rejects.toThrow('boom')

    const breaker = CircuitBreaker.getOrCreate('failing-service')
    expect(breaker.getHealthInfo().state).toBe(CircuitState.OPEN)

    await expect(svc.doWork()).rejects.toBeInstanceOf(CircuitBreakerOpenError)
  })
})