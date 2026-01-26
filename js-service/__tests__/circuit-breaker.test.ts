import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals'
import { CircuitBreaker, CircuitBreakerOpenError, CircuitState, DistributedCircuitBreakerClient, withCircuitBreaker } from '../src/circuit-breaker'

describe('CircuitBreakerOpenError', () => {
  it('sets name to CircuitBreakerOpenError and formats message', () => {
    const err = new CircuitBreakerOpenError('service-a', 123.4)
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('CircuitBreakerOpenError')
    expect(err.message).toContain("Circuit breaker 'service-a' is open")
    expect(err.message).toContain('123ms')
    expect((err as any).remainingTimeMs).toBe(123.4)
  })
})

describe('CircuitBreaker basic behavior', () => {
  let testCounter = 0

  afterEach(() => {
    jest.clearAllMocks()
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  it('executeSync success: returns value and updates metrics', () => {
    const name = `breaker-success-${++testCounter}`
    const cb = new CircuitBreaker(name, { failureThreshold: 5 })
    const result = cb.executeSync(() => 42)
    expect(result).toBe(42)

    const health = cb.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(1)
    expect(health.metrics.successfulCalls).toBe(1)
    expect(health.metrics.failedCalls).toBe(0)
    expect(health.state).toBe(CircuitState.CLOSED)
  })

  it('opens after reaching failureThreshold on failures', () => {
    const name = `breaker-open-threshold-${++testCounter}`
    const cb = new CircuitBreaker(name, { failureThreshold: 2, failureRateThreshold: 1, slidingWindowSize: 10 })
    expect(() => cb.executeSync(() => { throw new Error('fail1') })).toThrow('fail1')
    expect(cb.getHealthInfo().state).toBe(CircuitState.CLOSED)
    expect(() => cb.executeSync(() => { throw new Error('fail2') })).toThrow('fail2')
    expect(cb.getHealthInfo().state).toBe(CircuitState.OPEN)
  })

  it('rejects calls when OPEN without fallback and increments rejectedCalls', () => {
    jest.useFakeTimers()
    jest.setSystemTime(0)
    const name = `breaker-open-reject-${++testCounter}`
    const cb = new CircuitBreaker(name, { failureThreshold: 2, timeoutMs: 10000, failureRateThreshold: 1, slidingWindowSize: 10 })

    // Trip to OPEN
    expect(() => cb.executeSync(() => { throw new Error('f1') })).toThrow('f1')
    expect(() => cb.executeSync(() => { throw new Error('f2') })).toThrow('f2')
    expect(cb.getHealthInfo().state).toBe(CircuitState.OPEN)

    // Immediate third call should be rejected
    expect(() => cb.executeSync(() => 1)).toThrow(CircuitBreakerOpenError)
    const health = cb.getHealthInfo()
    expect(health.metrics.rejectedCalls).toBe(1)
    // totalCalls should not increment on rejected
    expect(health.metrics.totalCalls).toBe(2)

    try {
      cb.executeSync(() => 1)
    } catch (e: any) {
      expect(e).toBeInstanceOf(CircuitBreakerOpenError)
      // Remaining time should be near timeoutMs (since just opened)
      expect(e.remainingTimeMs).toBeGreaterThanOrEqual(9000)
      expect(e.remainingTimeMs).toBeLessThanOrEqual(10000)
      expect(e.message).toContain(name)
    }
  })

  it('uses fallback when OPEN', async () => {
    jest.useFakeTimers()
    jest.setSystemTime(0)
    const name = `breaker-open-fallback-${++testCounter}`
    const cb = new CircuitBreaker(name, { failureThreshold: 1, timeoutMs: 10000, failureRateThreshold: 1, slidingWindowSize: 10 })

    await expect(cb.execute(async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(cb.getHealthInfo().state).toBe(CircuitState.OPEN)

    const result = await cb.execute(async () => 123, async () => 999)
    expect(result).toBe(999)
    const health = cb.getHealthInfo()
    expect(health.metrics.rejectedCalls).toBe(1)
    // totalCalls remains 1 (only the first failing call)
    expect(health.metrics.totalCalls).toBe(1)
  })

  it('enters HALF_OPEN after timeout and allows limited calls (halfOpenMaxCalls)', () => {
    jest.useFakeTimers()
    jest.setSystemTime(0)
    const name = `breaker-halfopen-max-${++testCounter}`
    const cb = new CircuitBreaker(name, {
      failureThreshold: 1,
      timeoutMs: 5000,
      halfOpenMaxCalls: 2,
      successThreshold: 100, // keep from closing
      failureRateThreshold: 1,
      slidingWindowSize: 10
    })

    // Open
    expect(() => cb.executeSync(() => { throw new Error('err') })).toThrow('err')
    expect(cb.getHealthInfo().state).toBe(CircuitState.OPEN)

    // Advance time to allow HALF_OPEN
    jest.setSystemTime(5000)
    expect(cb.getState()).toBe(CircuitState.HALF_OPEN)

    // Two allowed calls
    expect(cb.executeSync(() => 'ok1')).toBe('ok1')
    expect(cb.executeSync(() => 'ok2')).toBe('ok2')

    // Third call blocked (exceeds halfOpenMaxCalls)
    expect(() => cb.executeSync(() => 'ok3')).toThrow(CircuitBreakerOpenError)

    const health = cb.getHealthInfo()
    expect(health.metrics.rejectedCalls).toBe(1)
    expect(health.state).toBe(CircuitState.HALF_OPEN)
  })

  it('HALF_OPEN failure transitions back to OPEN', () => {
    jest.useFakeTimers()
    jest.setSystemTime(0)
    const name = `breaker-halfopen-failure-${++testCounter}`
    const cb = new CircuitBreaker(name, { failureThreshold: 1, timeoutMs: 2000, failureRateThreshold: 1, slidingWindowSize: 10 })

    // Open
    expect(() => cb.executeSync(() => { throw new Error('initial') })).toThrow('initial')
    expect(cb.getHealthInfo().state).toBe(CircuitState.OPEN)

    // Move to HALF_OPEN
    jest.setSystemTime(2000)
    expect(cb.getState()).toBe(CircuitState.HALF_OPEN)

    // Fail in HALF_OPEN -> move back to OPEN
    expect(() => cb.executeSync(() => { throw new Error('half-open-fail') })).toThrow('half-open-fail')
    expect(cb.getHealthInfo().state).toBe(CircuitState.OPEN)
  })

  it('closes after successThreshold successes in HALF_OPEN and resets sliding window (failureRate=0)', () => {
    jest.useFakeTimers()
    jest.setSystemTime(0)
    const name = `breaker-halfopen-close-${++testCounter}`
    const cb = new CircuitBreaker(name, {
      failureThreshold: 2,
      timeoutMs: 1000,
      halfOpenMaxCalls: 5,
      successThreshold: 2,
      slidingWindowSize: 4,
      failureRateThreshold: 0.9
    })

    // Cause OPEN by failures
    expect(() => cb.executeSync(() => { throw new Error('f1') })).toThrow('f1')
    expect(() => cb.executeSync(() => { throw new Error('f2') })).toThrow('f2')
    expect(cb.getHealthInfo().state).toBe(CircuitState.OPEN)

    // Move to HALF_OPEN
    jest.setSystemTime(1000)
    expect(cb.getState()).toBe(CircuitState.HALF_OPEN)

    // Two successes to close
    expect(cb.executeSync(() => 'ok1')).toBe('ok1')
    expect(cb.executeSync(() => 'ok2')).toBe('ok2')
    const health = cb.getHealthInfo()
    expect(health.state).toBe(CircuitState.CLOSED)
    expect(health.failureRate).toBe(0)
  })

  it('calculates averageResponseTimeMs over recent calls', () => {
    jest.useRealTimers()
    const name = `breaker-avg-rt-${++testCounter}`
    const cb = new CircuitBreaker(name)

    const nowSpy = jest.spyOn(Date, 'now')
    nowSpy
      .mockImplementationOnce(() => 1000) // start1
      .mockImplementationOnce(() => 1100) // end1 duration 100
      .mockImplementationOnce(() => 2000) // start2
      .mockImplementationOnce(() => 2300) // end2 duration 300

    cb.executeSync(() => 'a')
    cb.executeSync(() => 'b')

    const avg = cb.getHealthInfo().metrics.averageResponseTimeMs
    expect(avg).toBe((100 + 300) / 2)
  })

  it('uses failureRateThreshold with sliding window to open early', () => {
    const name = `breaker-failure-rate-${++testCounter}`
    const cb = new CircuitBreaker(name, {
      failureThreshold: 100, // high to not trigger by count
      failureRateThreshold: 0.5,
      slidingWindowSize: 4,
    })

    // Two failures out of 4 window => failure rate 0.5 triggers OPEN
    expect(() => cb.executeSync(() => { throw new Error('f1') })).toThrow('f1')
    expect(cb.getHealthInfo().state).toBe(CircuitState.CLOSED)
    expect(() => cb.executeSync(() => { throw new Error('f2') })).toThrow('f2')
    expect(cb.getHealthInfo().state).toBe(CircuitState.OPEN)
  })

  it('getOrCreate returns the same instance and getRegistry exposes it', () => {
    const name = `breaker-registry-${++testCounter}`
    const cb1 = CircuitBreaker.getOrCreate(name, { failureThreshold: 3 })
    const cb2 = CircuitBreaker.getOrCreate(name, { failureThreshold: 99 })
    expect(cb1).toBe(cb2)

    const registry = CircuitBreaker.getRegistry()
    expect(registry.get(name)).toBe(cb1)
  })

  it('execute async records success and failure metrics', async () => {
    const name = `breaker-async-metrics-${++testCounter}`
    const cb = new CircuitBreaker(name, { failureThreshold: 2 })

    const res = await cb.execute(async () => 'ok')
    expect(res).toBe('ok')
    await expect(cb.execute(async () => { throw new Error('boom') })).rejects.toThrow('boom')

    const health = cb.getHealthInfo()
    expect(health.metrics.successfulCalls).toBe(1)
    expect(health.metrics.failedCalls).toBe(1)
    expect(health.metrics.totalCalls).toBe(2)
  })
})

describe('DistributedCircuitBreakerClient', () => {
  let originalFetch: any
  const g: any = globalThis

  beforeEach(() => {
    originalFetch = g.fetch
    g.fetch = jest.fn()
  })

  afterEach(() => {
    jest.clearAllMocks()
    jest.useRealTimers()
    g.fetch = originalFetch
  })

  it('register posts registration payload with NODE_ID', async () => {
    process.env.NODE_ID = 'node-1'
    ;(globalThis.fetch as any as jest.Mock).mockResolvedValue({ ok: true })

    const cb = new CircuitBreaker(`service-reg-${Date.now()}`, { failureThreshold: 7, successThreshold: 4 })
    const client = new DistributedCircuitBreakerClient('http://coordinator.test', 10000)
    client.register(cb)

    // Allow any microtasks
    await Promise.resolve()

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://coordinator.test/circuit-breakers/register',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: expect.any(String),
      }),
    )

    const call = (globalThis.fetch as jest.Mock).mock.calls[0]
    const body = JSON.parse(call[1].body)
    expect(body).toMatchObject({
      service: cb.name,
      node_id: 'node-1',
      failure_threshold: cb.getHealthInfo().config.failureThreshold,
      success_threshold: cb.getHealthInfo().config.successThreshold,
    })
  })

  it('startSync posts state periodically and stopSync stops it', async () => {
    jest.useFakeTimers()
    process.env.NODE_ID = 'node-2'
    ;(globalThis.fetch as any as jest.Mock).mockResolvedValue({ ok: true })

    const name = `service-sync-${Date.now()}`
    const cb = new CircuitBreaker(name)
    const client = new DistributedCircuitBreakerClient('http://coordinator.test', 1000)
    client.register(cb)

    client.startSync()
    // First tick
    jest.advanceTimersByTime(1000)
    await Promise.resolve()

    // Should have at least one POST to /state
    const stateCalls1 = (globalThis.fetch as jest.Mock).mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('/circuit-breakers/state')
    )
    expect(stateCalls1.length).toBeGreaterThanOrEqual(1)

    client.stopSync()
    jest.advanceTimersByTime(2000)
    await Promise.resolve()

    const totalStateCalls = (globalThis.fetch as jest.Mock).mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('/circuit-breakers/state')
    ).length
    // No additional calls after stop
    expect(totalStateCalls).toBe(stateCalls1.length)
  })

  it('getAggregatedState returns fetched value', async () => {
    const agg = {
      service: 'svc',
      consensusState: CircuitState.CLOSED,
      totalNodes: 3,
      healthScore: 0.85,
      nodeStates: { a: CircuitState.CLOSED, b: CircuitState.HALF_OPEN, c: CircuitState.CLOSED },
    }
    ;(globalThis.fetch as any as jest.Mock).mockResolvedValue({
      json: jest.fn().mockResolvedValue(agg),
    })

    const client = new DistributedCircuitBreakerClient('http://coordinator.test')
    const res = await client.getAggregatedState('svc')
    expect(res).toEqual(agg)

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://coordinator.test/circuit-breakers/svc/aggregate'
    )
  })

  it('getAggregatedState returns default on fetch error', async () => {
    ;(globalThis.fetch as any as jest.Mock).mockRejectedValue(new Error('network'))

    const client = new DistributedCircuitBreakerClient('http://coordinator.test')
    const res = await client.getAggregatedState('svc2')
    expect(res).toEqual({
      service: 'svc2',
      consensusState: CircuitState.CLOSED,
      totalNodes: 0,
      healthScore: 0,
      nodeStates: {},
    })
  })
})

describe('withCircuitBreaker decorator', () => {
  afterEach(() => {
    jest.clearAllMocks()
    jest.useRealTimers()
  })

  it('wraps method to execute through circuit breaker and records metrics', async () => {
    const serviceName = `decorator-svc-${Date.now()}`
    class TestService {
      @withCircuitBreaker(serviceName)
      async ok(value: number) {
        return value * 2
      }
    }

    const svc = new TestService()
    const result = await (svc as any).ok(21)
    expect(result).toBe(42)

    const breaker = CircuitBreaker.getOrCreate(serviceName)
    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(1)
    expect(health.metrics.successfulCalls).toBe(1)
    expect(health.state).toBe(CircuitState.CLOSED)
  })

  it('propagates underlying error and can open after repeated failures', async () => {
    const serviceName = `decorator-fail-${Date.now()}`
    class TestService {
      @withCircuitBreaker(serviceName, { failureThreshold: 2, failureRateThreshold: 1, slidingWindowSize: 10 })
      async boom() {
        throw new Error('explode')
      }
    }
    const svc = new TestService()

    await expect((svc as any).boom()).rejects.toThrow('explode')
    await expect((svc as any).boom()).rejects.toThrow('explode')

    const breaker = CircuitBreaker.getOrCreate(serviceName)
    expect(breaker.getHealthInfo().state).toBe(CircuitState.OPEN)

    await expect((svc as any).boom()).rejects.toBeInstanceOf(CircuitBreakerOpenError)
  })
})