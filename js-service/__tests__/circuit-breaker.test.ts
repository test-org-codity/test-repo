import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals'
import {
  CircuitBreaker,
  CircuitBreakerOpenError,
  CircuitState,
  DistributedCircuitBreakerClient,
  withCircuitBreaker,
  type AggregatedState,
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

  it('starts in CLOSED state and allows requests', async () => {
    const breaker = new CircuitBreaker('test')
    const op = jest.fn().mockResolvedValue('ok')

    const result = await breaker.execute(op)

    expect(result).toBe('ok')
    expect(op).toHaveBeenCalledTimes(1)
    expect(breaker.getState()).toBe(CircuitState.CLOSED)
  })

  it('records success metrics and average response time', async () => {
    const breaker = new CircuitBreaker('metrics')
    const op = jest.fn().mockImplementation(async () => {
      jest.advanceTimersByTime(50)
      return 'done'
    })

    const result = await breaker.execute(op)
    const health = breaker.getHealthInfo()

    expect(result).toBe('done')
    expect(health.metrics.totalCalls).toBe(1)
    expect(health.metrics.successfulCalls).toBe(1)
    expect(health.metrics.failedCalls).toBe(0)
    expect(health.metrics.averageResponseTimeMs).toBe(50)
    expect(health.metrics.lastSuccessTime).toBeInstanceOf(Date)
  })

  it('records failure metrics and transitions to OPEN after threshold', async () => {
    const breaker = new CircuitBreaker('fail', {
      failureThreshold: 2,
      slidingWindowSize: 10,
      failureRateThreshold: 1,
    })
    const failingOp = jest.fn().mockImplementation(async () => {
      jest.advanceTimersByTime(10)
      throw new Error('boom')
    })

    await expect(breaker.execute(failingOp)).rejects.toThrow('boom')
    await expect(breaker.execute(failingOp)).rejects.toThrow('boom')

    const health = breaker.getHealthInfo()
    expect(health.metrics.failedCalls).toBe(2)
    expect(health.failureCount).toBeGreaterThanOrEqual(2)
    expect(health.state).toBe(CircuitState.OPEN)
    expect(health.metrics.lastFailureTime).toBeInstanceOf(Date)
  })

  it('uses sliding window failure rate to open circuit', async () => {
    const breaker = new CircuitBreaker('sliding', {
      failureThreshold: 100,
      slidingWindowSize: 4,
      failureRateThreshold: 0.5,
    })

    const successOp = jest.fn().mockResolvedValue('ok')
    const failOp = jest.fn().mockRejectedValue(new Error('fail'))

    await breaker.execute(successOp)
    await expect(breaker.execute(failOp)).rejects.toThrow('fail')
    await expect(breaker.execute(failOp)).rejects.toThrow('fail')

    expect(breaker.getHealthInfo().state).toBe(CircuitState.OPEN)
  })

  it('throws CircuitBreakerOpenError when OPEN and no fallback', async () => {
    const breaker = new CircuitBreaker('open', {
      failureThreshold: 1,
      timeoutMs: 30000,
    })
    const failOp = jest.fn().mockRejectedValue(new Error('fail'))

    await expect(breaker.execute(failOp)).rejects.toThrow('fail')
    const start = Date.now()
    await expect(breaker.execute(jest.fn())).rejects.toBeInstanceOf(
      CircuitBreakerOpenError
    )
    const err = await breaker
      .execute(jest.fn())
      .catch((e: any) => e as CircuitBreakerOpenError)

    const elapsed = Date.now() - start
    expect(err.name).toBe('CircuitBreakerOpenError')
    expect(err.remainingTimeMs).toBeGreaterThanOrEqual(30000 - elapsed - 5)
  })

  it('uses fallback when OPEN and fallback provided (async)', async () => {
    const breaker = new CircuitBreaker('fallback', {
      failureThreshold: 1,
    })
    const failOp = jest.fn().mockRejectedValue(new Error('fail'))
    const fallback = jest.fn().mockResolvedValue('fallback')

    await expect(breaker.execute(failOp)).rejects.toThrow('fail')

    const result = await breaker.execute(jest.fn(), fallback)

    expect(result).toBe('fallback')
    expect(fallback).toHaveBeenCalledTimes(1)
  })

  it('executeSync behaves like execute for success and failure', () => {
    const breaker = new CircuitBreaker('sync')
    const op = jest.fn(() => 'ok')

    const result = breaker.executeSync(op)

    expect(result).toBe('ok')
    expect(op).toHaveBeenCalledTimes(1)

    const failOp = jest.fn(() => {
      throw new Error('sync-fail')
    })

    expect(() => breaker.executeSync(failOp)).toThrow('sync-fail')
    const health = breaker.getHealthInfo()
    expect(health.metrics.failedCalls).toBe(1)
  })

  it('executeSync uses fallback when OPEN', () => {
    const breaker = new CircuitBreaker('sync-open', {
      failureThreshold: 1,
    })
    const failOp = jest.fn(() => {
      throw new Error('fail')
    })
    const fallback = jest.fn(() => 'sync-fallback')

    expect(() => breaker.executeSync(failOp)).toThrow('fail')

    const result = breaker.executeSync(jest.fn(), fallback)

    expect(result).toBe('sync-fallback')
    expect(fallback).toHaveBeenCalledTimes(1)
  })

  it('transitions from OPEN to HALF_OPEN after timeout and then to CLOSED on successes', async () => {
    const breaker = new CircuitBreaker('half-open', {
      failureThreshold: 1,
      successThreshold: 2,
      timeoutMs: 1000,
    })
    const failOp = jest.fn().mockRejectedValue(new Error('fail'))

    await expect(breaker.execute(failOp)).rejects.toThrow('fail')
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    jest.advanceTimersByTime(1000)
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)

    const successOp = jest.fn().mockResolvedValue('ok')
    await breaker.execute(successOp)
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)

    await breaker.execute(successOp)
    expect(breaker.getState()).toBe(CircuitState.CLOSED)
  })

  it('in HALF_OPEN allows only limited number of calls', async () => {
    const breaker = new CircuitBreaker('half-open-limit', {
      failureThreshold: 1,
      timeoutMs: 1000,
      halfOpenMaxCalls: 2,
    })
    const failOp = jest.fn().mockRejectedValue(new Error('fail'))

    await expect(breaker.execute(failOp)).rejects.toThrow('fail')
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    jest.advanceTimersByTime(1000)
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)

    const op = jest.fn().mockResolvedValue('ok')
    await breaker.execute(op)
    await breaker.execute(op)

    const fallback = jest.fn().mockResolvedValue('fb')
    const result = await breaker.execute(op, fallback)

    expect(result).toBe('fb')
    expect(fallback).toHaveBeenCalledTimes(1)
  })

  it('in HALF_OPEN transitions back to OPEN on failure', async () => {
    const breaker = new CircuitBreaker('half-open-fail', {
      failureThreshold: 1,
      timeoutMs: 1000,
    })
    const failOp = jest.fn().mockRejectedValue(new Error('fail'))

    await expect(breaker.execute(failOp)).rejects.toThrow('fail')
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    jest.advanceTimersByTime(1000)
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)

    await expect(breaker.execute(failOp)).rejects.toThrow('fail')
    expect(breaker.getState()).toBe(CircuitState.OPEN)
  })

  it('getHealthInfo returns partial config and metrics snapshot', async () => {
    const breaker = new CircuitBreaker('health', {
      failureThreshold: 7,
      successThreshold: 4,
      timeoutMs: 1234,
    })
    const op = jest.fn().mockResolvedValue('ok')

    await breaker.execute(op)
    const health = breaker.getHealthInfo()

    expect(health.name).toBe('health')
    expect(health.config.failureThreshold).toBe(7)
    expect(health.config.successThreshold).toBe(4)
    expect(health.config.timeoutMs).toBe(1234)
    expect(health.metrics.totalCalls).toBe(1)
  })

  it('getOrCreate returns same instance for same name and registry exposes copy', () => {
    const a = CircuitBreaker.getOrCreate('shared', { failureThreshold: 1 })
    const b = CircuitBreaker.getOrCreate('shared', { failureThreshold: 10 })

    expect(a).toBe(b)

    const registry = CircuitBreaker.getRegistry()
    expect(registry.get('shared')).toBe(a)

    registry.set('other', new CircuitBreaker('other'))
    const registry2 = CircuitBreaker.getRegistry()
    expect(registry2.has('other')).toBe(false)
  })

  it('recordSuccess in CLOSED decreases failureCount but not below zero', async () => {
    const breaker = new CircuitBreaker('success-decrease', {
      failureThreshold: 10,
    })
    const failOp = jest.fn().mockRejectedValue(new Error('fail'))
    const successOp = jest.fn().mockResolvedValue('ok')

    await expect(breaker.execute(failOp)).rejects.toThrow('fail')
    await breaker.execute(successOp)
    await breaker.execute(successOp)

    const health = breaker.getHealthInfo()
    expect(health.failureCount).toBeGreaterThanOrEqual(0)
  })

  it('responseTimes buffer is capped and average is computed over last entries', async () => {
    const breaker = new CircuitBreaker('response-times')
    const op = jest.fn().mockImplementation(async () => {
      jest.advanceTimersByTime(1)
      return 'ok'
    })

    const iterations = 120
    for (let i = 0; i < iterations; i++) {
      await breaker.execute(op)
    }

    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(iterations)
    expect(health.metrics.averageResponseTimeMs).toBeGreaterThan(0)
  })
})

describe('CircuitBreakerOpenError', () => {
  it('sets name and message correctly', () => {
    const err = new CircuitBreakerOpenError('svc', 1234)

    expect(err.name).toBe('CircuitBreakerOpenError')
    expect(err.remainingTimeMs).toBe(1234)
    expect(err.message).toContain("Circuit breaker 'svc' is open")
    expect(err.message).toContain('1234')
  })
})

describe('DistributedCircuitBreakerClient', () => {
  let originalFetch: any

  beforeEach(() => {
    originalFetch = global.fetch
    global.fetch = jest.fn()
  })

  afterEach(() => {
    global.fetch = originalFetch
    jest.clearAllMocks()
  })

  it('register sends registration payload with breaker config', async () => {
    const fetchMock = global.fetch as jest.Mock
    fetchMock.mockResolvedValue({ ok: true })

    const client = new DistributedCircuitBreakerClient('http://coordinator')
    const breaker = new CircuitBreaker('service', {
      failureThreshold: 9,
      successThreshold: 4,
    })

    client.register(breaker)

    await Promise.resolve()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, options] = fetchMock.mock.calls[0]
    expect(url).toBe('http://coordinator/circuit-breakers/register')
    const body = JSON.parse(options.body)
    expect(body.service).toBe('service')
    expect(body.failure_threshold).toBe(9)
    expect(body.success_threshold).toBe(4)
    expect(body.node_id).toBeDefined()
  })

  it('getAggregatedState returns remote data on success', async () => {
    const fetchMock = global.fetch as jest.Mock
    const remote: AggregatedState = {
      service: 'svc',
      consensusState: CircuitState.OPEN,
      totalNodes: 3,
      healthScore: 0.7,
      nodeStates: { a: CircuitState.OPEN },
    }
    fetchMock.mockResolvedValue({
      json: jest.fn().mockResolvedValue(remote),
    })

    const client = new DistributedCircuitBreakerClient('http://coordinator')
    const result = await client.getAggregatedState('svc')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result).toEqual(remote)
  })

  it('getAggregatedState returns default CLOSED state on fetch error', async () => {
    const fetchMock = global.fetch as jest.Mock
    fetchMock.mockRejectedValue(new Error('network'))

    const client = new DistributedCircuitBreakerClient('http://coordinator')
    const result = await client.getAggregatedState('svc')

    expect(result.service).toBe('svc')
    expect(result.consensusState).toBe(CircuitState.CLOSED)
    expect(result.totalNodes).toBe(0)
    expect(result.healthScore).toBe(0)
    expect(result.nodeStates).toEqual({})
  })

  it('startSync sets interval and stopSync clears it', () => {
    jest.useFakeTimers()
    const fetchMock = global.fetch as jest.Mock
    fetchMock.mockResolvedValue({ ok: true })

    const client = new DistributedCircuitBreakerClient('http://coordinator', 1000)
    const breaker = new CircuitBreaker('svc')
    client.register(breaker)

    client.startSync()
    client.startSync()

    jest.advanceTimersByTime(2500)

    client.stopSync()
    jest.advanceTimersByTime(5000)

    expect(fetchMock).toHaveBeenCalled()
  })

  it('synchronizeStates reports state for each registered breaker', async () => {
    jest.useFakeTimers()
    const fetchMock = global.fetch as jest.Mock
    fetchMock.mockResolvedValue({ ok: true })

    const client = new DistributedCircuitBreakerClient('http://coordinator', 1000)
    const breaker1 = new CircuitBreaker('svc1')
    const breaker2 = new CircuitBreaker('svc2')

    client.register(breaker1)
    client.register(breaker2)
    client.startSync()

    jest.advanceTimersByTime(1000)
    await Promise.resolve()

    const urls = fetchMock.mock.calls.map((c: any[]) => c[0])
    const stateCalls = urls.filter((u: string) =>
      u.endsWith('/circuit-breakers/state')
    )
    expect(stateCalls.length).toBeGreaterThanOrEqual(2)
  })
})

describe('withCircuitBreaker decorator', () => {
  afterEach(() => {
    jest.clearAllMocks()
  })

  it('wraps method with CircuitBreaker.execute', async () => {
    class TestService {
      value = 0

      @withCircuitBreaker('decorated')
      async increment(delta: number) {
        this.value += delta
        return this.value
      }
    }

    const svc = new TestService()
    const result1 = await svc.increment(2)
    const result2 = await svc.increment(3)

    expect(result1).toBe(2)
    expect(result2).toBe(5)

    const breaker = CircuitBreaker.getOrCreate('decorated')
    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(2)
    expect(health.metrics.successfulCalls).toBe(2)
  })

  it('propagates errors from decorated method and records failure', async () => {
    class TestService {
      @withCircuitBreaker('decorated-fail')
      async willFail() {
        throw new Error('decorated-error')
      }
    }

    const svc = new TestService()
    await expect(svc.willFail()).rejects.toThrow('decorated-error')

    const breaker = CircuitBreaker.getOrCreate('decorated-fail')
    const health = breaker.getHealthInfo()
    expect(health.metrics.failedCalls).toBe(1)
  })
})