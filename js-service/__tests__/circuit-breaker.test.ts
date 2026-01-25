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

  it('executes successful async operation and records success metrics', async () => {
    const breaker = new CircuitBreaker('test-service')
    const op = jest.fn().mockResolvedValue('ok')

    const result = await breaker.execute(op)

    expect(result).toBe('ok')
    expect(op).toHaveBeenCalledTimes(1)

    const health = breaker.getHealthInfo()
    expect(health.state).toBe(CircuitState.CLOSED)
    expect(health.successCount).toBe(0) // internal successCount only used for HALF_OPEN
    expect(health.failureCount).toBe(0)
    expect(health.metrics.totalCalls).toBe(1)
    expect(health.metrics.successfulCalls).toBe(1)
    expect(health.metrics.failedCalls).toBe(0)
    expect(health.metrics.rejectedCalls).toBe(0)
    expect(health.metrics.lastSuccessTime).toBeInstanceOf(Date)
    expect(health.metrics.averageResponseTimeMs).toBeGreaterThanOrEqual(0)
  })

  it('executes failing async operation and records failure metrics', async () => {
    const breaker = new CircuitBreaker('test-service')
    const error = new Error('fail')
    const op = jest.fn().mockRejectedValue(error)

    await expect(breaker.execute(op)).rejects.toBe(error)

    const health = breaker.getHealthInfo()
    expect(health.state).toBe(CircuitState.CLOSED)
    expect(health.failureCount).toBe(1)
    expect(health.metrics.totalCalls).toBe(1)
    expect(health.metrics.failedCalls).toBe(1)
    expect(health.metrics.successfulCalls).toBe(0)
    expect(health.metrics.lastFailureTime).toBeInstanceOf(Date)
  })

  it('opens circuit after reaching failureThreshold', async () => {
    const breaker = new CircuitBreaker('test-service', { failureThreshold: 2 })
    const error = new Error('fail')
    const op = jest.fn().mockRejectedValue(error)

    await expect(breaker.execute(op)).rejects.toBe(error)
    await expect(breaker.execute(op)).rejects.toBe(error)

    const health = breaker.getHealthInfo()
    expect(health.state).toBe(CircuitState.OPEN)
    expect(health.failureCount).toBe(2)
    expect(health.metrics.stateTransitions).toBe(1)
  })

  it('opens circuit when failureRate exceeds threshold using sliding window', async () => {
    const breaker = new CircuitBreaker('test-service', {
      slidingWindowSize: 4,
      failureRateThreshold: 0.5,
      failureThreshold: 100, // ensure rate triggers before count
    })

    const successOp = jest.fn().mockResolvedValue('ok')
    const failOp = jest.fn().mockRejectedValue(new Error('fail'))

    await breaker.execute(successOp) // success
    await expect(breaker.execute(failOp)).rejects.toThrow()
    await expect(breaker.execute(failOp)).rejects.toThrow()

    const health = breaker.getHealthInfo()
    expect(health.state).toBe(CircuitState.OPEN)
    expect(health.failureRate).toBeGreaterThanOrEqual(0.5)
  })

  it('rejects calls when OPEN and throws CircuitBreakerOpenError without fallback', async () => {
    const breaker = new CircuitBreaker('test-service', {
      failureThreshold: 1,
      timeoutMs: 10000,
    })
    const error = new Error('fail')
    const op = jest.fn().mockRejectedValue(error)

    await expect(breaker.execute(op)).rejects.toBe(error)

    const failingOp = jest.fn().mockResolvedValue('ok')
    await expect(breaker.execute(failingOp)).rejects.toBeInstanceOf(
      CircuitBreakerOpenError
    )

    const health = breaker.getHealthInfo()
    expect(health.metrics.rejectedCalls).toBe(1)
  })

  it('uses fallback when OPEN and fallback is provided (async)', async () => {
    const breaker = new CircuitBreaker('test-service', {
      failureThreshold: 1,
      timeoutMs: 10000,
    })
    const error = new Error('fail')
    const op = jest.fn().mockRejectedValue(error)

    await expect(breaker.execute(op)).rejects.toBe(error)

    const mainOp = jest.fn().mockResolvedValue('ok')
    const fallback = jest.fn().mockResolvedValue('fallback')

    const result = await breaker.execute(mainOp, fallback)

    expect(result).toBe('fallback')
    expect(mainOp).not.toHaveBeenCalled()
    expect(fallback).toHaveBeenCalledTimes(1)

    const health = breaker.getHealthInfo()
    expect(health.metrics.rejectedCalls).toBe(1)
  })

  it('moves from OPEN to HALF_OPEN after timeout and allows limited calls', async () => {
    const breaker = new CircuitBreaker('test-service', {
      failureThreshold: 1,
      timeoutMs: 1000,
      halfOpenMaxCalls: 2,
    })
    const error = new Error('fail')
    const failingOp = jest.fn().mockRejectedValue(error)

    await expect(breaker.execute(failingOp)).rejects.toBe(error)
    expect(breaker.getHealthInfo().state).toBe(CircuitState.OPEN)

    jest.advanceTimersByTime(1000)
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)

    const successOp = jest.fn().mockResolvedValue('ok')
    await breaker.execute(successOp)
    await breaker.execute(successOp)

    const thirdOp = jest.fn().mockResolvedValue('ok')
    const fallback = jest.fn().mockResolvedValue('fb')
    const result = await breaker.execute(thirdOp, fallback)

    expect(result).toBe('fb')
    expect(thirdOp).not.toHaveBeenCalled()
  })

  it('closes circuit from HALF_OPEN after enough successes', async () => {
    const breaker = new CircuitBreaker('test-service', {
      failureThreshold: 1,
      timeoutMs: 1000,
      halfOpenMaxCalls: 5,
      successThreshold: 2,
    })
    const error = new Error('fail')
    const failingOp = jest.fn().mockRejectedValue(error)

    await expect(breaker.execute(failingOp)).rejects.toBe(error)
    expect(breaker.getHealthInfo().state).toBe(CircuitState.OPEN)

    jest.advanceTimersByTime(1000)
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)

    const successOp = jest.fn().mockResolvedValue('ok')
    await breaker.execute(successOp)
    await breaker.execute(successOp)

    const health = breaker.getHealthInfo()
    expect(health.state).toBe(CircuitState.CLOSED)
    expect(health.failureCount).toBe(0)
    expect(health.metrics.stateTransitions).toBeGreaterThanOrEqual(2)
  })

  it('transitions from HALF_OPEN back to OPEN on failure', async () => {
    const breaker = new CircuitBreaker('test-service', {
      failureThreshold: 1,
      timeoutMs: 1000,
      halfOpenMaxCalls: 3,
    })
    const error = new Error('fail')
    const failingOp = jest.fn().mockRejectedValue(error)

    await expect(breaker.execute(failingOp)).rejects.toBe(error)
    expect(breaker.getHealthInfo().state).toBe(CircuitState.OPEN)

    jest.advanceTimersByTime(1000)
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)

    await expect(breaker.execute(failingOp)).rejects.toBe(error)

    const health = breaker.getHealthInfo()
    expect(health.state).toBe(CircuitState.OPEN)
  })

  it('executeSync behaves like execute for success and failure', () => {
    const breaker = new CircuitBreaker('sync-service')

    const successOp = jest.fn(() => 'ok')
    const result = breaker.executeSync(successOp)
    expect(result).toBe('ok')
    expect(successOp).toHaveBeenCalledTimes(1)

    const error = new Error('sync-fail')
    const failingOp = jest.fn(() => {
      throw error
    })
    expect(() => breaker.executeSync(failingOp)).toThrow(error)

    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(2)
    expect(health.metrics.successfulCalls).toBe(1)
    expect(health.metrics.failedCalls).toBe(1)
  })

  it('executeSync uses fallback when OPEN', () => {
    const breaker = new CircuitBreaker('sync-service', {
      failureThreshold: 1,
      timeoutMs: 10000,
    })

    const error = new Error('sync-fail')
    const failingOp = jest.fn(() => {
      throw error
    })
    expect(() => breaker.executeSync(failingOp)).toThrow(error)

    const mainOp = jest.fn(() => 'ok')
    const fallback = jest.fn(() => 'fallback')

    const result = breaker.executeSync(mainOp, fallback)
    expect(result).toBe('fallback')
    expect(mainOp).not.toHaveBeenCalled()
    expect(fallback).toHaveBeenCalledTimes(1)
  })

  it('getOrCreate returns same instance for same name and stores in registry', () => {
    const breaker1 = CircuitBreaker.getOrCreate('shared-service', {
      failureThreshold: 2,
    })
    const breaker2 = CircuitBreaker.getOrCreate('shared-service')

    expect(breaker1).toBe(breaker2)

    const registry = CircuitBreaker.getRegistry()
    expect(registry.get('shared-service')).toBe(breaker1)
  })

  it('getRegistry returns a copy of internal registry map', () => {
    const breaker = CircuitBreaker.getOrCreate('registry-service')
    const registry1 = CircuitBreaker.getRegistry()
    const registry2 = CircuitBreaker.getRegistry()

    expect(registry1).not.toBe(registry2)
    expect(registry1.get('registry-service')).toBe(breaker)
    expect(registry2.get('registry-service')).toBe(breaker)
  })

  it('CircuitBreakerOpenError message includes name and remaining time', () => {
    const err = new CircuitBreakerOpenError('svc', 1234.6)
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('CircuitBreakerOpenError')
    expect(err.message).toContain("Circuit breaker 'svc' is open")
    expect(err.message).toContain('1235ms')
    expect(err.remainingTimeMs).toBe(1234.6)
  })

  it('averageResponseTimeMs is computed from recent response times with cap', async () => {
    const breaker = new CircuitBreaker('timing-service')
    const op = jest.fn().mockResolvedValue('ok')

    for (let i = 0; i < 120; i++) {
      jest.advanceTimersByTime(5)
      await breaker.execute(op)
    }

    const health = breaker.getHealthInfo()
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
    global.fetch = originalFetch
    jest.clearAllMocks()
  })

  it('register sends registration payload with breaker config', async () => {
    const fetchMock = global.fetch as jest.Mock
    fetchMock.mockResolvedValue({ ok: true })

    const breaker = new CircuitBreaker('svc', {
      failureThreshold: 7,
      successThreshold: 4,
    })
    const client = new DistributedCircuitBreakerClient('http://coord')

    client.register(breaker)

    await Promise.resolve()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, options] = fetchMock.mock.calls[0]
    expect(url).toBe('http://coord/circuit-breakers/register')
    const body = JSON.parse(options.body)
    expect(body.service).toBe('svc')
    expect(body.failure_threshold).toBe(7)
    expect(body.success_threshold).toBe(4)
    expect(body.node_id).toBeDefined()
  })

  it('startSync sets interval and synchronizeStates reports state for each breaker', async () => {
    const fetchMock = global.fetch as jest.Mock
    fetchMock.mockResolvedValue({ ok: true })

    const client = new DistributedCircuitBreakerClient('http://coord', 1000)
    const breaker1 = new CircuitBreaker('svc1')
    const breaker2 = new CircuitBreaker('svc2')

    client.register(breaker1)
    client.register(breaker2)

    client.startSync()

    jest.advanceTimersByTime(1000)

    await Promise.resolve()

    const calls = fetchMock.mock.calls.filter(
      (c: any[]) => c[0] === 'http://coord/circuit-breakers/state'
    )
    expect(calls.length).toBeGreaterThanOrEqual(2)

    const services = calls.map(([, options]) => JSON.parse(options.body).service)
    expect(services).toEqual(expect.arrayContaining(['svc1', 'svc2']))
  })

  it('stopSync clears interval and prevents further syncs', async () => {
    const fetchMock = global.fetch as jest.Mock
    fetchMock.mockResolvedValue({ ok: true })

    const client = new DistributedCircuitBreakerClient('http://coord', 1000)
    const breaker = new CircuitBreaker('svc')
    client.register(breaker)
    client.startSync()

    jest.advanceTimersByTime(1000)
    await Promise.resolve()
    const callsBefore = fetchMock.mock.calls.length

    client.stopSync()
    jest.advanceTimersByTime(5000)
    await Promise.resolve()

    const callsAfter = fetchMock.mock.calls.length
    expect(callsAfter).toBe(callsBefore)
  })

  it('getAggregatedState returns parsed response on success', async () => {
    const fetchMock = global.fetch as jest.Mock
    const aggregated = {
      service: 'svc',
      consensusState: CircuitState.OPEN,
      totalNodes: 3,
      healthScore: 0.8,
      nodeStates: { a: CircuitState.CLOSED },
    }
    fetchMock.mockResolvedValue({
      json: jest.fn().mockResolvedValue(aggregated),
    })

    const client = new DistributedCircuitBreakerClient('http://coord')
    const result = await client.getAggregatedState('svc')

    expect(fetchMock).toHaveBeenCalledWith(
      'http://coord/circuit-breakers/svc/aggregate'
    )
    expect(result).toEqual(aggregated)
  })

  it('getAggregatedState returns default CLOSED state on fetch error', async () => {
    const fetchMock = global.fetch as jest.Mock
    fetchMock.mockRejectedValue(new Error('network'))

    const client = new DistributedCircuitBreakerClient('http://coord')
    const result = await client.getAggregatedState('svc')

    expect(result.service).toBe('svc')
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

  it('wraps method with CircuitBreaker.execute and reuses same breaker by name', async () => {
    class TestService {
      public calls = 0

      @withCircuitBreaker('decorated-service', { failureThreshold: 2 })
      async doWork(value: string): Promise<string> {
        this.calls++
        return `done-${value}`
      }
    }

    const svc1 = new TestService()
    const svc2 = new TestService()

    const result1 = await svc1.doWork('a')
    const result2 = await svc2.doWork('b')

    expect(result1).toBe('done-a')
    expect(result2).toBe('done-b')
    expect(svc1.calls).toBe(1)
    expect(svc2.calls).toBe(1)

    const registry = CircuitBreaker.getRegistry()
    const breaker = registry.get('decorated-service')
    expect(breaker).toBeDefined()
    expect(breaker!.getHealthInfo().metrics.totalCalls).toBe(2)
  })

  it('decorated method propagates errors and increments failure metrics', async () => {
    class TestService {
      public calls = 0

      @withCircuitBreaker('decorated-fail', { failureThreshold: 2 })
      async doWork(): Promise<void> {
        this.calls++
        throw new Error('boom')
      }
    }

    const svc = new TestService()
    await expect(svc.doWork()).rejects.toThrow('boom')

    const registry = CircuitBreaker.getRegistry()
    const breaker = registry.get('decorated-fail')
    expect(breaker).toBeDefined()
    const health = breaker!.getHealthInfo()
    expect(health.metrics.failedCalls).toBe(1)
    expect(health.failureCount).toBe(1)
  })
})