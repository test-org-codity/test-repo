import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals'
import {
  CircuitBreaker,
  CircuitBreakerOpenError,
  CircuitState,
  DistributedCircuitBreakerClient,
  withCircuitBreaker,
  type CircuitBreakerConfig,
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
    const health = breaker.getHealthInfo()
    expect(health.state).toBe(CircuitState.CLOSED)
    expect(health.successCount).toBe(0) // internal successCount is only used for HALF_OPEN
    expect(health.metrics.successfulCalls).toBe(1)
  })

  it('records failures and opens after reaching failureThreshold', async () => {
    const config: Partial<CircuitBreakerConfig> = { failureThreshold: 2, slidingWindowSize: 10 }
    const breaker = new CircuitBreaker('fail-breaker', config)
    const failingOp = jest.fn().mockRejectedValue(new Error('fail'))

    await expect(breaker.execute(failingOp)).rejects.toThrow('fail')
    await expect(breaker.execute(failingOp)).rejects.toThrow('fail')

    expect(breaker.getState()).toBe(CircuitState.OPEN)
    const health = breaker.getHealthInfo()
    expect(health.failureCount).toBe(2)
    expect(health.metrics.failedCalls).toBe(2)
    expect(health.metrics.stateTransitions).toBe(1)
  })

  it('opens based on failureRateThreshold using sliding window', async () => {
    const config: Partial<CircuitBreakerConfig> = {
      failureThreshold: 100, // high so only rate matters
      slidingWindowSize: 4,
      failureRateThreshold: 0.5,
    }
    const breaker = new CircuitBreaker('rate-breaker', config)

    const success = jest.fn().mockResolvedValue('ok')
    const fail = jest.fn().mockRejectedValue(new Error('bad'))

    await breaker.execute(success) // success
    await expect(breaker.execute(fail)).rejects.toThrow('bad') // 1/2 failures = 0.5 -> open

    expect(breaker.getState()).toBe(CircuitState.OPEN)
    const health = breaker.getHealthInfo()
    expect(health.failureRate).toBeGreaterThanOrEqual(0.5)
  })

  it('rejects calls when OPEN and throws CircuitBreakerOpenError without fallback', async () => {
    const breaker = new CircuitBreaker('open-test', {
      failureThreshold: 1,
      timeoutMs: 30000,
    })
    const failingOp = jest.fn().mockRejectedValue(new Error('fail'))

    await expect(breaker.execute(failingOp)).rejects.toThrow('fail')
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    const start = Date.now()
    await expect(breaker.execute(jest.fn())).rejects.toBeInstanceOf(CircuitBreakerOpenError)
    const err = await breaker.execute(jest.fn()).catch(e => e as CircuitBreakerOpenError)

    expect(err).toBeInstanceOf(CircuitBreakerOpenError)
    expect(err.name).toBe('CircuitBreakerOpenError')
    const remaining = 30000 - (Date.now() - start)
    expect(err.remainingTimeMs).toBeGreaterThanOrEqual(0)
    expect(err.remainingTimeMs).toBeLessThanOrEqual(30000)
  })

  it('uses fallback when OPEN and does not throw', async () => {
    const breaker = new CircuitBreaker('fallback-test', {
      failureThreshold: 1,
      timeoutMs: 30000,
    })
    const failingOp = jest.fn().mockRejectedValue(new Error('fail'))
    const fallback = jest.fn().mockResolvedValue('fallback')

    await expect(breaker.execute(failingOp)).rejects.toThrow('fail')
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    const result = await breaker.execute(jest.fn(), fallback)

    expect(result).toBe('fallback')
    expect(fallback).toHaveBeenCalledTimes(1)
    const health = breaker.getHealthInfo()
    expect(health.metrics.rejectedCalls).toBe(1)
  })

  it('transitions from OPEN to HALF_OPEN after timeout and limits half-open calls', async () => {
    const breaker = new CircuitBreaker('half-open-test', {
      failureThreshold: 1,
      timeoutMs: 1000,
      halfOpenMaxCalls: 2,
    })
    const failingOp = jest.fn().mockRejectedValue(new Error('fail'))

    await expect(breaker.execute(failingOp)).rejects.toThrow('fail')
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    jest.advanceTimersByTime(1000)
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)

    const op = jest.fn().mockResolvedValue('ok')
    await breaker.execute(op)
    await breaker.execute(op)

    await expect(breaker.execute(op)).rejects.toBeInstanceOf(CircuitBreakerOpenError)
    const health = breaker.getHealthInfo()
    expect(health.metrics.rejectedCalls).toBe(1)
  })

  it('closes from HALF_OPEN after enough successes', async () => {
    const breaker = new CircuitBreaker('recover-test', {
      failureThreshold: 1,
      timeoutMs: 1000,
      halfOpenMaxCalls: 5,
      successThreshold: 2,
    })
    const failingOp = jest.fn().mockRejectedValue(new Error('fail'))

    await expect(breaker.execute(failingOp)).rejects.toThrow('fail')
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    jest.advanceTimersByTime(1000)
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)

    const op = jest.fn().mockResolvedValue('ok')
    await breaker.execute(op)
    await breaker.execute(op)

    expect(breaker.getState()).toBe(CircuitState.CLOSED)
    const health = breaker.getHealthInfo()
    expect(health.failureCount).toBe(0)
    expect(health.successCount).toBe(0)
  })

  it('HALF_OPEN failure immediately transitions back to OPEN', async () => {
    const breaker = new CircuitBreaker('half-open-fail', {
      failureThreshold: 1,
      timeoutMs: 1000,
      halfOpenMaxCalls: 3,
    })
    const failingOp = jest.fn().mockRejectedValue(new Error('fail'))

    await expect(breaker.execute(failingOp)).rejects.toThrow('fail')
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    jest.advanceTimersByTime(1000)
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)

    await expect(breaker.execute(failingOp)).rejects.toThrow('fail')
    expect(breaker.getState()).toBe(CircuitState.OPEN)
  })

  it('executeSync behaves like async execute including fallback and errors', () => {
    const breaker = new CircuitBreaker('sync-test', { failureThreshold: 1 })
    const op = jest.fn().mockReturnValue('ok')

    const result = breaker.executeSync(op)
    expect(result).toBe('ok')
    expect(op).toHaveBeenCalledTimes(1)

    const failingOp = jest.fn(() => {
      throw new Error('fail')
    })
    expect(() => breaker.executeSync(failingOp)).toThrow('fail')
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    const fallback = jest.fn().mockReturnValue('fallback')
    const res2 = breaker.executeSync(jest.fn(), fallback)
    expect(res2).toBe('fallback')
    expect(fallback).toHaveBeenCalledTimes(1)
  })

  it('getOrCreate returns same instance for same name and stores in registry', () => {
    const config: Partial<CircuitBreakerConfig> = { failureThreshold: 2 }
    const b1 = CircuitBreaker.getOrCreate('shared', config)
    const b2 = CircuitBreaker.getOrCreate('shared')

    expect(b1).toBe(b2)

    const registry = CircuitBreaker.getRegistry()
    expect(registry.get('shared')).toBe(b1)
  })

  it('records response times and computes averageResponseTimeMs', async () => {
    const breaker = new CircuitBreaker('timing-test')
    let now = Date.now()
    jest.spyOn(Date, 'now').mockImplementation(() => now)

    const op = jest.fn().mockImplementation(async () => {
      now += 50
      return 'ok'
    })

    await breaker.execute(op)
    await breaker.execute(op)
    await breaker.execute(op)

    const health = breaker.getHealthInfo()
    expect(health.metrics.averageResponseTimeMs).toBe(50)
    expect(health.metrics.totalCalls).toBe(3)
  })

  it('sliding window wraps correctly and failure rate is based on window', async () => {
    const breaker = new CircuitBreaker('window-test', {
      slidingWindowSize: 3,
      failureThreshold: 100,
      failureRateThreshold: 1,
    })

    const success = jest.fn().mockResolvedValue('ok')
    const fail = jest.fn().mockRejectedValue(new Error('bad'))

    await breaker.execute(success) // [T,T,T] initial, then [T,T,T]
    await expect(breaker.execute(fail)).rejects.toThrow('bad') // [F,T,T]
    await breaker.execute(success) // [F,T,T] -> [F,T,T]
    await expect(breaker.execute(fail)).rejects.toThrow('bad') // [F,F,T]

    const health = breaker.getHealthInfo()
    expect(health.failureRate).toBeCloseTo(2 / 3)
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
    global.fetch = originalFetch
    jest.clearAllMocks()
  })

  it('register sends registration payload with breaker config', async () => {
    const fetchMock = global.fetch as jest.Mock
    fetchMock.mockResolvedValue({ ok: true })

    const breaker = new CircuitBreaker('service-a', {
      failureThreshold: 7,
      successThreshold: 4,
    })
    const client = new DistributedCircuitBreakerClient('http://coordinator', 10000)

    client.register(breaker)

    await Promise.resolve()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, options] = fetchMock.mock.calls[0]
    expect(url).toBe('http://coordinator/circuit-breakers/register')
    const body = JSON.parse(options.body)
    expect(body.service).toBe('service-a')
    expect(body.failure_threshold).toBe(7)
    expect(body.success_threshold).toBe(4)
    expect(body.node_id).toBeDefined()
  })

  it('startSync sets interval and synchronizeStates reports state', async () => {
    const fetchMock = global.fetch as jest.Mock
    fetchMock.mockResolvedValue({ ok: true })

    const breaker = new CircuitBreaker('service-b')
    const client = new DistributedCircuitBreakerClient('http://coordinator', 1000)

    client.register(breaker)
    client.startSync()

    jest.advanceTimersByTime(1000)
    await Promise.resolve()

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [url, options] = fetchMock.mock.calls[1]
    expect(url).toBe('http://coordinator/circuit-breakers/state')
    const body = JSON.parse(options.body)
    expect(body.service).toBe('service-b')
    expect(body.state).toBe(CircuitState.CLOSED)
    expect(typeof body.timestamp).toBe('number')
    expect(body.health_info.name).toBe('service-b')

    client.stopSync()
  })

  it('stopSync clears sync interval and prevents further syncs', async () => {
    const fetchMock = global.fetch as jest.Mock
    fetchMock.mockResolvedValue({ ok: true })

    const breaker = new CircuitBreaker('service-c')
    const client = new DistributedCircuitBreakerClient('http://coordinator', 1000)

    client.register(breaker)
    client.startSync()
    client.stopSync()

    jest.advanceTimersByTime(3000)
    await Promise.resolve()

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('getAggregatedState returns parsed response on success', async () => {
    const aggregated: AggregatedState = {
      service: 'svc',
      consensusState: CircuitState.OPEN,
      totalNodes: 3,
      healthScore: 0.7,
      nodeStates: { a: CircuitState.OPEN, b: CircuitState.CLOSED },
    }
    const fetchMock = global.fetch as jest.Mock
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

  it('wraps method and executes through CircuitBreaker', async () => {
    class TestService {
      @withCircuitBreaker('decorator-test')
      async doWork(value: string): Promise<string> {
        return `result-${value}`
      }
    }

    const service = new TestService()
    const result = await service.doWork('x')

    expect(result).toBe('result-x')

    const breaker = CircuitBreaker.getOrCreate('decorator-test')
    const health = breaker.getHealthInfo()
    expect(health.metrics.successfulCalls).toBe(1)
  })

  it('propagates errors through CircuitBreaker when decorated method throws', async () => {
    class TestService {
      @withCircuitBreaker('decorator-fail', { failureThreshold: 1 })
      async doWork(): Promise<string> {
        throw new Error('boom')
      }
    }

    const service = new TestService()
    await expect(service.doWork()).rejects.toThrow('boom')

    const breaker = CircuitBreaker.getOrCreate('decorator-fail')
    expect(breaker.getState()).toBe(CircuitState.OPEN)
    const health = breaker.getHealthInfo()
    expect(health.metrics.failedCalls).toBe(1)
  })
})