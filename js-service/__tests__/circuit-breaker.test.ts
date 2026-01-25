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

  it('executes async operation successfully and records metrics', async () => {
    const breaker = new CircuitBreaker('test-async')
    const op = jest.fn().mockResolvedValue('ok')

    const result = await breaker.execute(op)

    expect(result).toBe('ok')
    expect(op).toHaveBeenCalledTimes(1)

    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(1)
    expect(health.metrics.successfulCalls).toBe(1)
    expect(health.metrics.failedCalls).toBe(0)
    expect(health.metrics.rejectedCalls).toBe(0)
    expect(health.metrics.lastSuccessTime).toBeInstanceOf(Date)
    expect(health.metrics.averageResponseTimeMs).toBeGreaterThanOrEqual(0)
  })

  it('executes sync operation successfully and records metrics', () => {
    const breaker = new CircuitBreaker('test-sync')
    const op = jest.fn().mockReturnValue('ok')

    const result = breaker.executeSync(op)

    expect(result).toBe('ok')
    expect(op).toHaveBeenCalledTimes(1)

    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(1)
    expect(health.metrics.successfulCalls).toBe(1)
    expect(health.metrics.failedCalls).toBe(0)
    expect(health.metrics.rejectedCalls).toBe(0)
    expect(health.metrics.lastSuccessTime).toBeInstanceOf(Date)
  })

  it('records failure for async operation and keeps circuit closed until threshold', async () => {
    const breaker = new CircuitBreaker('test-failure', { failureThreshold: 2 })
    const error = new Error('fail')
    const op = jest.fn().mockRejectedValue(error)

    await expect(breaker.execute(op)).rejects.toBe(error)
    await expect(breaker.execute(op)).rejects.toBe(error)

    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(2)
    expect(health.metrics.failedCalls).toBe(2)
    expect(health.failureCount).toBe(2)
    expect(health.state).toBe(CircuitState.OPEN)
  })

  it('opens circuit when failureThreshold reached', async () => {
    const breaker = new CircuitBreaker('open-threshold', {
      failureThreshold: 1,
      timeoutMs: 10000,
    })
    const error = new Error('boom')
    const failing = jest.fn().mockRejectedValue(error)

    await expect(breaker.execute(failing)).rejects.toBe(error)

    const healthAfter = breaker.getHealthInfo()
    expect(healthAfter.state).toBe(CircuitState.OPEN)
    expect(healthAfter.failureCount).toBe(1)

    const op2 = jest.fn().mockResolvedValue('ok')
    await expect(breaker.execute(op2)).rejects.toBeInstanceOf(CircuitBreakerOpenError)
    expect(op2).not.toHaveBeenCalled()

    const healthFinal = breaker.getHealthInfo()
    expect(healthFinal.metrics.rejectedCalls).toBe(1)
  })

  it('uses failureRateThreshold with sliding window to open circuit', async () => {
    const breaker = new CircuitBreaker('failure-rate', {
      slidingWindowSize: 4,
      failureRateThreshold: 0.5,
      failureThreshold: 100,
    })

    const success = jest.fn().mockResolvedValue('ok')
    const fail = jest.fn().mockRejectedValue(new Error('x'))

    await breaker.execute(success) // success
    await expect(breaker.execute(fail)).rejects.toThrow('x') // 1/2 failures
    await breaker.execute(success) // 1/3 failures
    await expect(breaker.execute(fail)).rejects.toThrow('x') // 2/4 failures = 0.5

    const health = breaker.getHealthInfo()
    expect(health.state).toBe(CircuitState.OPEN)
    expect(health.failureRate).toBeGreaterThanOrEqual(0.5)
  })

  it('decrements failureCount on success while closed', async () => {
    const breaker = new CircuitBreaker('decrement-failure', { failureThreshold: 10 })
    const fail = jest.fn().mockRejectedValue(new Error('x'))
    const success = jest.fn().mockResolvedValue('ok')

    await expect(breaker.execute(fail)).rejects.toThrow('x')
    await expect(breaker.execute(fail)).rejects.toThrow('x')

    let health = breaker.getHealthInfo()
    expect(health.failureCount).toBe(2)

    await breaker.execute(success)
    health = breaker.getHealthInfo()
    expect(health.failureCount).toBe(1)
  })

  it('transitions from OPEN to HALF_OPEN after timeout and limits half-open calls', async () => {
    const breaker = new CircuitBreaker('half-open', {
      failureThreshold: 1,
      timeoutMs: 1000,
      halfOpenMaxCalls: 2,
    })
    const fail = jest.fn().mockRejectedValue(new Error('x'))

    await expect(breaker.execute(fail)).rejects.toThrow('x')
    expect(breaker.getHealthInfo().state).toBe(CircuitState.OPEN)

    jest.advanceTimersByTime(1001)
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)

    const op = jest.fn().mockResolvedValue('ok')
    await breaker.execute(op)
    await breaker.execute(op)
    expect(op).toHaveBeenCalledTimes(2)

    const op2 = jest.fn().mockResolvedValue('ok2')
    await expect(breaker.execute(op2)).rejects.toBeInstanceOf(CircuitBreakerOpenError)
    expect(op2).not.toHaveBeenCalled()
  })

  it('closes circuit from HALF_OPEN after enough successes', async () => {
    const breaker = new CircuitBreaker('half-open-close', {
      failureThreshold: 1,
      timeoutMs: 1000,
      successThreshold: 2,
      halfOpenMaxCalls: 5,
    })
    const fail = jest.fn().mockRejectedValue(new Error('x'))

    await expect(breaker.execute(fail)).rejects.toThrow('x')
    expect(breaker.getHealthInfo().state).toBe(CircuitState.OPEN)

    jest.advanceTimersByTime(1001)
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)

    const success = jest.fn().mockResolvedValue('ok')
    await breaker.execute(success)
    expect(breaker.getHealthInfo().state).toBe(CircuitState.HALF_OPEN)

    await breaker.execute(success)
    expect(breaker.getHealthInfo().state).toBe(CircuitState.CLOSED)
  })

  it('transitions from HALF_OPEN back to OPEN on failure', async () => {
    const breaker = new CircuitBreaker('half-open-fail', {
      failureThreshold: 1,
      timeoutMs: 1000,
      successThreshold: 2,
      halfOpenMaxCalls: 5,
    })
    const fail = jest.fn().mockRejectedValue(new Error('x'))

    await expect(breaker.execute(fail)).rejects.toThrow('x')
    expect(breaker.getHealthInfo().state).toBe(CircuitState.OPEN)

    jest.advanceTimersByTime(1001)
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)

    await expect(breaker.execute(fail)).rejects.toThrow('x')
    expect(breaker.getHealthInfo().state).toBe(CircuitState.OPEN)
  })

  it('uses fallback when circuit is open for async execute', async () => {
    const breaker = new CircuitBreaker('fallback-async', {
      failureThreshold: 1,
      timeoutMs: 10000,
    })
    const fail = jest.fn().mockRejectedValue(new Error('x'))
    const fallback = jest.fn().mockResolvedValue('fallback')

    await expect(breaker.execute(fail)).rejects.toThrow('x')
    expect(breaker.getHealthInfo().state).toBe(CircuitState.OPEN)

    const result = await breaker.execute(jest.fn(), fallback)
    expect(result).toBe('fallback')
    expect(fallback).toHaveBeenCalledTimes(1)
  })

  it('uses fallback when circuit is open for sync execute', () => {
    const breaker = new CircuitBreaker('fallback-sync', {
      failureThreshold: 1,
      timeoutMs: 10000,
    })
    const fail = jest.fn(() => {
      throw new Error('x')
    })
    const fallback = jest.fn(() => 'fallback')

    expect(() => breaker.executeSync(fail)).toThrow('x')
    expect(breaker.getHealthInfo().state).toBe(CircuitState.OPEN)

    const result = breaker.executeSync(jest.fn(), fallback)
    expect(result).toBe('fallback')
    expect(fallback).toHaveBeenCalledTimes(1)
  })

  it('CircuitBreakerOpenError exposes name and remainingTimeMs', async () => {
    const breaker = new CircuitBreaker('error-info', {
      failureThreshold: 1,
      timeoutMs: 5000,
    })
    const fail = jest.fn().mockRejectedValue(new Error('x'))

    await expect(breaker.execute(fail)).rejects.toThrow('x')

    jest.advanceTimersByTime(1000)

    await expect(breaker.execute(jest.fn())).rejects.toThrow(CircuitBreakerOpenError)
    try {
      await breaker.execute(jest.fn())
    } catch (e: any) {
      expect(e).toBeInstanceOf(CircuitBreakerOpenError)
      expect(e.name).toBe('CircuitBreakerOpenError')
      expect(e.remainingTimeMs).toBeGreaterThanOrEqual(0)
      expect(e.message).toContain("Circuit breaker 'error-info' is open.")
    }
  })

  it('getOrCreate returns same instance for same name and stores in registry', () => {
    const cb1 = CircuitBreaker.getOrCreate('shared')
    const cb2 = CircuitBreaker.getOrCreate('shared')

    expect(cb1).toBe(cb2)

    const registry = CircuitBreaker.getRegistry()
    expect(registry.get('shared')).toBe(cb1)
  })

  it('getRegistry returns a copy of internal registry map', () => {
    const cb = CircuitBreaker.getOrCreate('registry-test')
    const registry1 = CircuitBreaker.getRegistry()
    const registry2 = CircuitBreaker.getRegistry()

    expect(registry1).not.toBe(registry2)
    expect(registry1.get('registry-test')).toBe(cb)
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
    expect(health.state).toBe(CircuitState.CLOSED)
    expect(health.config.failureThreshold).toBe(7)
    expect(health.config.successThreshold).toBe(4)
    expect(health.config.timeoutMs).toBe(1234)
    expect(health.metrics.totalCalls).toBe(1)
  })

  it('response time metrics keep sliding window of maxResponseTimes', async () => {
    const breaker = new CircuitBreaker('response-times')
    const op = jest.fn().mockResolvedValue('ok')

    for (let i = 0; i < 150; i++) {
      jest.advanceTimersByTime(10)
      await breaker.execute(op)
    }

    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(150)
    expect(health.metrics.successfulCalls).toBe(150)
    expect(health.metrics.averageResponseTimeMs).toBeGreaterThanOrEqual(0)
  })
})

describe('DistributedCircuitBreakerClient', () => {
  let originalFetch: any
  let fetchMock: jest.Mock

  beforeEach(() => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2024-01-01T00:00:00.000Z'))
    originalFetch = global.fetch
    fetchMock = jest.fn()
    global.fetch = fetchMock
  })

  afterEach(() => {
    jest.useRealTimers()
    global.fetch = originalFetch
    jest.clearAllMocks()
  })

  it('register sends registration payload with breaker config', async () => {
    const breaker = new CircuitBreaker('service-a', {
      failureThreshold: 10,
      successThreshold: 2,
    })
    fetchMock.mockResolvedValue({ ok: true })

    const client = new DistributedCircuitBreakerClient('http://coordinator')
    client.register(breaker)

    await Promise.resolve()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, options] = fetchMock.mock.calls[0]
    expect(url).toBe('http://coordinator/circuit-breakers/register')
    const body = JSON.parse(options.body)
    expect(body.service).toBe('service-a')
    expect(body.failure_threshold).toBe(10)
    expect(body.success_threshold).toBe(2)
    expect(body.node_id).toBeDefined()
  })

  it('startSync sets interval and synchronizeStates reports state', async () => {
    const breaker = new CircuitBreaker('sync-service')
    fetchMock.mockResolvedValue({ ok: true })

    const client = new DistributedCircuitBreakerClient('http://coordinator', 1000)
    client.register(breaker)
    client.startSync()

    jest.advanceTimersByTime(1001)
    await Promise.resolve()

    expect(fetchMock).toHaveBeenCalled()
    const calls = fetchMock.mock.calls.filter(
      (c: any[]) => c[0] === 'http://coordinator/circuit-breakers/state'
    )
    expect(calls.length).toBeGreaterThanOrEqual(1)
    const [, options] = calls[0]
    const body = JSON.parse(options.body)
    expect(body.service).toBe('sync-service')
    expect(body.state).toBe(CircuitState.CLOSED)
    expect(body.health_info.name).toBe('sync-service')

    client.stopSync()
  })

  it('stopSync clears sync interval and prevents further syncs', async () => {
    const breaker = new CircuitBreaker('sync-stop')
    fetchMock.mockResolvedValue({ ok: true })

    const client = new DistributedCircuitBreakerClient('http://coordinator', 1000)
    client.register(breaker)
    client.startSync()

    jest.advanceTimersByTime(1001)
    await Promise.resolve()
    const callsBefore = fetchMock.mock.calls.length

    client.stopSync()
    jest.advanceTimersByTime(5000)
    await Promise.resolve()

    const callsAfter = fetchMock.mock.calls.length
    expect(callsAfter).toBe(callsBefore)
  })

  it('getAggregatedState returns remote data on success', async () => {
    const aggregated: AggregatedState = {
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

  it('wraps method with CircuitBreaker.execute', async () => {
    class TestService {
      public calls: any[] = []

      @withCircuitBreaker('decorated-service')
      async doWork(arg: string): Promise<string> {
        this.calls.push(arg)
        return `result-${arg}`
      }
    }

    const service = new TestService()
    const result = await service.doWork('x')

    expect(result).toBe('result-x')

    const breaker = CircuitBreaker.getOrCreate('decorated-service')
    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(1)
    expect(health.metrics.successfulCalls).toBe(1)
    expect(service.calls).toEqual(['x'])
  })

  it('propagates errors from decorated method through breaker', async () => {
    class TestService {
      @withCircuitBreaker('decorated-error')
      async fail(): Promise<void> {
        throw new Error('decorated-fail')
      }
    }

    const service = new TestService()
    await expect(service.fail()).rejects.toThrow('decorated-fail')

    const breaker = CircuitBreaker.getOrCreate('decorated-error')
    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(1)
    expect(health.metrics.failedCalls).toBe(1)
  })
})