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

  it('executes successful async operation and records success metrics', async () => {
    const breaker = new CircuitBreaker('test-success')
    const op = jest.fn().mockResolvedValue('ok')

    const result = await breaker.execute(op)

    expect(result).toBe('ok')
    const health = breaker.getHealthInfo()
    expect(health.state).toBe(CircuitState.CLOSED)
    expect(health.metrics.totalCalls).toBe(1)
    expect(health.metrics.successfulCalls).toBe(1)
    expect(health.metrics.failedCalls).toBe(0)
    expect(health.metrics.rejectedCalls).toBe(0)
    expect(health.metrics.lastSuccessTime).toBeInstanceOf(Date)
    expect(health.metrics.averageResponseTimeMs).toBeGreaterThanOrEqual(0)
  })

  it('executes failing async operation and records failure metrics', async () => {
    const breaker = new CircuitBreaker('test-failure')
    const error = new Error('fail')
    const op = jest.fn().mockRejectedValue(error)

    await expect(breaker.execute(op)).rejects.toBe(error)

    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(1)
    expect(health.metrics.failedCalls).toBe(1)
    expect(health.metrics.successfulCalls).toBe(0)
    expect(health.metrics.lastFailureTime).toBeInstanceOf(Date)
    expect(health.failureCount).toBe(1)
  })

  it('executes successful sync operation and records success metrics', () => {
    const breaker = new CircuitBreaker('test-sync-success')
    const op = jest.fn().mockReturnValue('ok')

    const result = breaker.executeSync(op)

    expect(result).toBe('ok')
    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(1)
    expect(health.metrics.successfulCalls).toBe(1)
    expect(health.metrics.failedCalls).toBe(0)
  })

  it('executes failing sync operation and records failure metrics', () => {
    const breaker = new CircuitBreaker('test-sync-failure')
    const error = new Error('sync fail')
    const op = jest.fn(() => {
      throw error
    })

    expect(() => breaker.executeSync(op)).toThrow(error)

    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(1)
    expect(health.metrics.failedCalls).toBe(1)
    expect(health.failureCount).toBe(1)
  })

  it('opens circuit after reaching failureThreshold by count', async () => {
    const breaker = new CircuitBreaker('test-open-threshold', {
      failureThreshold: 3,
      slidingWindowSize: 10,
      failureRateThreshold: 1, // ensure count-based opening
    })
    const error = new Error('fail')
    const failingOp = jest.fn().mockRejectedValue(error)

    await expect(breaker.execute(failingOp)).rejects.toBe(error)
    await expect(breaker.execute(failingOp)).rejects.toBe(error)
    await expect(breaker.execute(failingOp)).rejects.toBe(error)

    expect(breaker.getHealthInfo().state).toBe(CircuitState.OPEN)
  })

  it('opens circuit based on failureRateThreshold using sliding window', async () => {
    const breaker = new CircuitBreaker('test-open-rate', {
      failureThreshold: 100, // high so only rate matters
      slidingWindowSize: 4,
      failureRateThreshold: 0.5,
    })

    const successOp = jest.fn().mockResolvedValue('ok')
    const failError = new Error('fail')
    const failOp = jest.fn().mockRejectedValue(failError)

    await breaker.execute(successOp) // success
    await expect(breaker.execute(failOp)).rejects.toBe(failError) // 1/2 failures
    await breaker.execute(successOp) // 1/3 failures
    await expect(breaker.execute(failOp)).rejects.toBe(failError) // 2/4 failures = 0.5

    expect(breaker.getHealthInfo().failureRate).toBe(0.5)
    expect(breaker.getHealthInfo().state).toBe(CircuitState.OPEN)
  })

  it('rejects calls when OPEN and throws CircuitBreakerOpenError without fallback', async () => {
    const breaker = new CircuitBreaker('test-open-reject', {
      failureThreshold: 1,
      timeoutMs: 30000,
    })
    const error = new Error('fail')
    const failingOp = jest.fn().mockRejectedValue(error)

    await expect(breaker.execute(failingOp)).rejects.toBe(error)
    expect(breaker.getHealthInfo().state).toBe(CircuitState.OPEN)

    const start = Date.now()
    await expect(
      breaker.execute(async () => 'should-not-run')
    ).rejects.toBeInstanceOf(CircuitBreakerOpenError)

    const thrownError = await breaker
      .execute(async () => 'x')
      .catch((e) => e as CircuitBreakerOpenError)

    expect(thrownError).toBeInstanceOf(CircuitBreakerOpenError)
    expect(thrownError.name).toBe('CircuitBreakerOpenError')
    const elapsed = Date.now() - start
    const expectedRemaining = 30000 - elapsed
    expect(thrownError.remainingTimeMs).toBeGreaterThanOrEqual(0)
    expect(thrownError.remainingTimeMs).toBeLessThanOrEqual(30000)
    expect(thrownError.message).toContain("Circuit breaker 'test-open-reject' is open.")
  })

  it('uses fallback when OPEN and fallback is provided (async)', async () => {
    const breaker = new CircuitBreaker('test-open-fallback', {
      failureThreshold: 1,
    })
    const error = new Error('fail')
    const failingOp = jest.fn().mockRejectedValue(error)

    await expect(breaker.execute(failingOp)).rejects.toBe(error)
    expect(breaker.getHealthInfo().state).toBe(CircuitState.OPEN)

    const fallback = jest.fn().mockResolvedValue('fallback-value')

    const result = await breaker.execute(
      async () => {
        throw new Error('should not run')
      },
      fallback
    )

    expect(result).toBe('fallback-value')
    expect(fallback).toHaveBeenCalledTimes(1)
    expect(breaker.getHealthInfo().metrics.rejectedCalls).toBe(1)
  })

  it('uses fallback when OPEN and fallback is provided (sync)', () => {
    const breaker = new CircuitBreaker('test-open-fallback-sync', {
      failureThreshold: 1,
    })
    const error = new Error('fail')
    const failingOp = jest.fn().mockImplementation(() => {
      throw error
    })

    expect(() => breaker.executeSync(failingOp)).toThrow(error)
    expect(breaker.getHealthInfo().state).toBe(CircuitState.OPEN)

    const fallback = jest.fn().mockReturnValue('fallback-sync')

    const result = breaker.executeSync(
      () => {
        throw new Error('should not run')
      },
      fallback
    )

    expect(result).toBe('fallback-sync')
    expect(fallback).toHaveBeenCalledTimes(1)
    expect(breaker.getHealthInfo().metrics.rejectedCalls).toBe(1)
  })

  it('transitions from OPEN to HALF_OPEN after timeout and limits half-open calls', async () => {
    const breaker = new CircuitBreaker('test-half-open', {
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

    const op = jest.fn().mockResolvedValue('ok')
    const fallback = jest.fn().mockResolvedValue('fb')

    const r1 = await breaker.execute(op, fallback)
    const r2 = await breaker.execute(op, fallback)
    expect(r1).toBe('ok')
    expect(r2).toBe('ok')
    expect(op).toHaveBeenCalledTimes(2)

    const r3 = await breaker.execute(op, fallback)
    expect(r3).toBe('fb')
    expect(fallback).toHaveBeenCalledTimes(1)
  })

  it('closes circuit from HALF_OPEN after enough successes', async () => {
    const breaker = new CircuitBreaker('test-half-open-close', {
      failureThreshold: 1,
      successThreshold: 2,
      timeoutMs: 1000,
      halfOpenMaxCalls: 5,
    })
    const error = new Error('fail')
    const failingOp = jest.fn().mockRejectedValue(error)

    await expect(breaker.execute(failingOp)).rejects.toBe(error)
    expect(breaker.getHealthInfo().state).toBe(CircuitState.OPEN)

    jest.advanceTimersByTime(1000)
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)

    const op = jest.fn().mockResolvedValue('ok')
    await breaker.execute(op)
    await breaker.execute(op)

    expect(breaker.getHealthInfo().state).toBe(CircuitState.CLOSED)
    expect(breaker.getHealthInfo().failureCount).toBe(0)
    expect(breaker.getHealthInfo().successCount).toBe(0)
  })

  it('reopens circuit from HALF_OPEN on failure', async () => {
    const breaker = new CircuitBreaker('test-half-open-reopen', {
      failureThreshold: 1,
      timeoutMs: 1000,
      halfOpenMaxCalls: 5,
    })
    const error = new Error('fail')
    const failingOp = jest.fn().mockRejectedValue(error)

    await expect(breaker.execute(failingOp)).rejects.toBe(error)
    expect(breaker.getHealthInfo().state).toBe(CircuitState.OPEN)

    jest.advanceTimersByTime(1000)
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)

    await expect(breaker.execute(failingOp)).rejects.toBe(error)
    expect(breaker.getHealthInfo().state).toBe(CircuitState.OPEN)
  })

  it('getOrCreate returns same instance for same name and stores in registry', () => {
    const b1 = CircuitBreaker.getOrCreate('shared', { failureThreshold: 2 })
    const b2 = CircuitBreaker.getOrCreate('shared', { failureThreshold: 10 })

    expect(b1).toBe(b2)

    const registry = CircuitBreaker.getRegistry()
    expect(registry.get('shared')).toBe(b1)
  })

  it('calculateFailureRate uses sliding window and affects health info', async () => {
    const breaker = new CircuitBreaker('test-failure-rate', {
      slidingWindowSize: 4,
      failureThreshold: 100,
      failureRateThreshold: 1,
    })

    const successOp = jest.fn().mockResolvedValue('ok')
    const failError = new Error('fail')
    const failOp = jest.fn().mockRejectedValue(failError)

    await breaker.execute(successOp)
    await breaker.execute(successOp)
    await expect(breaker.execute(failOp)).rejects.toBe(failError)
    await breaker.execute(successOp)

    const health = breaker.getHealthInfo()
    expect(health.failureRate).toBe(0.25)
  })

  it('tracks averageResponseTimeMs based on recent response times', async () => {
    const breaker = new CircuitBreaker('test-response-time')
    const op = jest.fn().mockResolvedValue('ok')

    jest.setSystemTime(new Date('2024-01-01T00:00:00.000Z'))
    const p1 = breaker.execute(async () => {
      jest.advanceTimersByTime(10)
      return op()
    })

    jest.setSystemTime(new Date('2024-01-01T00:00:00.020Z'))
    const p2 = breaker.execute(async () => {
      jest.advanceTimersByTime(20)
      return op()
    })

    await Promise.all([p1, p2])

    const avg = breaker.getHealthInfo().metrics.averageResponseTimeMs
    expect(avg).toBeGreaterThanOrEqual(10)
    expect(avg).toBeLessThanOrEqual(20)
  })
})

describe('CircuitBreakerOpenError', () => {
  it('sets name, remainingTimeMs and message correctly', () => {
    const err = new CircuitBreakerOpenError('svc', 1234.6)

    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('CircuitBreakerOpenError')
    expect(err.remainingTimeMs).toBe(1234.6)
    expect(err.message).toBe("Circuit breaker 'svc' is open. Retry after 1235ms")
  })
})

describe('DistributedCircuitBreakerClient', () => {
  let originalFetch: any

  beforeEach(() => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2024-01-01T00:00:00.000Z'))
    originalFetch = global.fetch
    global.fetch = jest.fn().mockResolvedValue({
      json: jest.fn().mockResolvedValue({}),
    })
  })

  afterEach(() => {
    jest.useRealTimers()
    global.fetch = originalFetch
    jest.clearAllMocks()
  })

  it('register sends registration payload with breaker health config', async () => {
    const client = new DistributedCircuitBreakerClient('http://coordinator')
    const breaker = new CircuitBreaker('service-a', {
      failureThreshold: 7,
      successThreshold: 4,
    })

    await client.register(breaker)

    expect(global.fetch).toHaveBeenCalledWith(
      'http://coordinator/circuit-breakers/register',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
    )

    const body = JSON.parse(
      (global.fetch as jest.Mock).mock.calls[0][1].body as string
    )
    expect(body.service).toBe('service-a')
    expect(body.failure_threshold).toBe(7)
    expect(body.success_threshold).toBe(4)
    expect(body.node_id).toBeDefined()
  })

  it('getAggregatedState returns parsed response on success', async () => {
    const aggregated: AggregatedState = {
      service: 'svc',
      consensusState: CircuitState.OPEN,
      totalNodes: 3,
      healthScore: 0.8,
      nodeStates: { n1: CircuitState.CLOSED },
    }
    ;(global.fetch as jest.Mock).mockResolvedValueOnce({
      json: jest.fn().mockResolvedValue(aggregated),
    })

    const client = new DistributedCircuitBreakerClient('http://coordinator')
    const result = await client.getAggregatedState('svc')

    expect(global.fetch).toHaveBeenCalledWith(
      'http://coordinator/circuit-breakers/svc/aggregate'
    )
    expect(result).toEqual(aggregated)
  })

  it('getAggregatedState returns default CLOSED state on fetch error', async () => {
    ;(global.fetch as jest.Mock).mockRejectedValueOnce(new Error('network'))

    const client = new DistributedCircuitBreakerClient('http://coordinator')
    const result = await client.getAggregatedState('svc-default')

    expect(result.service).toBe('svc-default')
    expect(result.consensusState).toBe(CircuitState.CLOSED)
    expect(result.totalNodes).toBe(0)
    expect(result.healthScore).toBe(0)
    expect(result.nodeStates).toEqual({})
  })

  it('startSync sets interval and synchronizeStates reports state for registered breakers', async () => {
    const client = new DistributedCircuitBreakerClient('http://coordinator', 1000)
    const breaker1 = new CircuitBreaker('svc1')
    const breaker2 = new CircuitBreaker('svc2')

    await client.register(breaker1)
    await client.register(breaker2)
    ;(global.fetch as jest.Mock).mockResolvedValue({
      json: jest.fn().mockResolvedValue({}),
    })

    client.startSync()

    jest.advanceTimersByTime(1000)

    const calls = (global.fetch as jest.Mock).mock.calls.filter(
      (c: any[]) => c[0] === 'http://coordinator/circuit-breakers/state'
    )
    expect(calls.length).toBeGreaterThanOrEqual(2)

    const payloads = calls.map((c) => JSON.parse(c[1].body))
    const services = payloads.map((p) => p.service)
    expect(services).toEqual(expect.arrayContaining(['svc1', 'svc2']))

    client.stopSync()
  })

  it('stopSync clears sync interval and prevents further sync calls', async () => {
    const client = new DistributedCircuitBreakerClient('http://coordinator', 500)
    const breaker = new CircuitBreaker('svc-stop')
    await client.register(breaker)

    client.startSync()
    jest.advanceTimersByTime(500)

    const callsBefore = (global.fetch as jest.Mock).mock.calls.length

    client.stopSync()
    jest.advanceTimersByTime(2000)

    const callsAfter = (global.fetch as jest.Mock).mock.calls.length
    expect(callsAfter).toBe(callsBefore)
  })
})

describe('withCircuitBreaker decorator', () => {
  afterEach(() => {
    jest.clearAllMocks()
  })

  it('wraps method and executes through CircuitBreaker', async () => {
    class TestService {
      value = 0

      @withCircuitBreaker('decorator-test')
      async increment(by: number) {
        this.value += by
        return this.value
      }
    }

    const svc = new TestService()
    const result1 = await svc.increment(2)
    const result2 = await svc.increment(3)

    expect(result1).toBe(2)
    expect(result2).toBe(5)

    const breaker = CircuitBreaker.getOrCreate('decorator-test')
    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(2)
    expect(health.metrics.successfulCalls).toBe(2)
  })

  it('propagates errors from decorated method and records failure', async () => {
    class TestService {
      @withCircuitBreaker('decorator-error')
      async fail() {
        throw new Error('boom')
      }
    }

    const svc = new TestService()
    await expect(svc.fail()).rejects.toThrow('boom')

    const breaker = CircuitBreaker.getOrCreate('decorator-error')
    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(1)
    expect(health.metrics.failedCalls).toBe(1)
  })
})