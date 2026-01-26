import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals'
import { CircuitBreaker, CircuitBreakerOpenError, CircuitState, DistributedCircuitBreakerClient, withCircuitBreaker } from '../src/circuit-breaker'

describe('CircuitBreakerOpenError', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('sets name, message, and remainingTimeMs correctly', () => {
    const err = new CircuitBreakerOpenError('svc', 1234.6)
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('CircuitBreakerOpenError')
    expect(err.remainingTimeMs).toBe(1234.6)
    expect(err.message).toBe("Circuit breaker 'svc' is open. Retry after 1235ms")
  })
})

describe('CircuitBreaker basic behavior', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('executes success and updates metrics', async () => {
    const cb = new CircuitBreaker('svc-basic-1', { timeoutMs: 1000 })
    const operation = jest.fn().mockResolvedValue('ok')

    const result = await cb.execute(operation)

    expect(result).toBe('ok')
    const health = cb.getHealthInfo()
    expect(health.state).toBe(CircuitState.CLOSED)
    expect(health.metrics.totalCalls).toBe(1)
    expect(health.metrics.successfulCalls).toBe(1)
    expect(health.metrics.failedCalls).toBe(0)
    expect(health.metrics.lastSuccessTime).toBeInstanceOf(Date)
  })

  it('opens after reaching failureThreshold', async () => {
    const cb = new CircuitBreaker('svc-basic-2', {
      failureThreshold: 2,
      failureRateThreshold: 1,
      timeoutMs: 10000,
    })
    const opFail = jest.fn().mockRejectedValue(new Error('fail'))

    await expect(cb.execute(opFail)).rejects.toThrow('fail')
    await expect(cb.execute(opFail)).rejects.toThrow('fail')

    expect(cb.getState()).toBe(CircuitState.OPEN)
    const health = cb.getHealthInfo()
    expect(health.metrics.failedCalls).toBe(2)
    expect(health.metrics.stateTransitions).toBe(1)
  })

  it('rejects when open and uses fallback', async () => {
    const cb = new CircuitBreaker('svc-basic-3', {
      failureThreshold: 1,
      failureRateThreshold: 1,
      timeoutMs: 10000,
    })
    const opFail = jest.fn().mockRejectedValue(new Error('fail'))
    await expect(cb.execute(opFail)).rejects.toThrow('fail')
    expect(cb.getState()).toBe(CircuitState.OPEN)

    const fallback = jest.fn().mockResolvedValue('fallback')
    const result = await cb.execute(jest.fn(), fallback)

    expect(result).toBe('fallback')
    const health = cb.getHealthInfo()
    expect(health.metrics.rejectedCalls).toBe(1)
    expect(health.metrics.totalCalls).toBe(1) // totalCalls not incremented for rejected
  })

  it('rejects when open without fallback and throws CircuitBreakerOpenError with remaining time', async () => {
    const cb = new CircuitBreaker('svc-basic-4', {
      failureThreshold: 1,
      failureRateThreshold: 1,
      timeoutMs: 10000,
    })

    // Open the breaker at time t=1000
    const nowSpy = jest.spyOn(Date, 'now')
    nowSpy.mockReturnValueOnce(1000) // during execute to measure start time and open
    const opFail = jest.fn().mockRejectedValue(new Error('fail'))
    await expect(cb.execute(opFail)).rejects.toThrow('fail')
    expect(cb.getState()).toBe(CircuitState.OPEN)

    // Now at t=1200, remaining should be 9800
    nowSpy.mockReturnValue(1200)
    await expect(cb.execute(jest.fn())).rejects.toBeInstanceOf(CircuitBreakerOpenError)
    await expect(cb.execute(jest.fn())).rejects.toMatchObject({
      name: 'CircuitBreakerOpenError',
      remainingTimeMs: 9800,
      message: "Circuit breaker 'svc-basic-4' is open. Retry after 9800ms",
    })
  })

  it('transitions to HALF_OPEN after timeout and enforces halfOpenMaxCalls', () => {
    const cb = new CircuitBreaker('svc-basic-5', {
      failureThreshold: 1,
      timeoutMs: 1000,
      halfOpenMaxCalls: 2,
      successThreshold: 3,
      failureRateThreshold: 1,
    })

    const nowSpy = jest.spyOn(Date, 'now')
    // Open at t=0
    nowSpy.mockReturnValueOnce(0)
    expect(() => cb.executeSync(() => { throw new Error('x') })).toThrow('x')
    expect(cb.getState()).toBe(CircuitState.OPEN)

    // At t=1000, should attempt reset to HALF_OPEN when getState called
    nowSpy.mockReturnValue(1000)
    expect(cb.getState()).toBe(CircuitState.HALF_OPEN)

    // Allow 2 calls in HALF_OPEN
    expect(cb.executeSync(() => 'ok')).toBe('ok')
    expect(cb.executeSync(() => 'ok')).toBe('ok')

    // Third call should be rejected (no fallback)
    expect(() => cb.executeSync(() => 'ok')).toThrow(CircuitBreakerOpenError)

    const health = cb.getHealthInfo()
    expect(health.metrics.rejectedCalls).toBe(1)
  })

  it('closes after reaching successThreshold in HALF_OPEN', () => {
    const cb = new CircuitBreaker('svc-basic-6', {
      failureThreshold: 1,
      timeoutMs: 1000,
      halfOpenMaxCalls: 5,
      successThreshold: 2,
      failureRateThreshold: 1,
    })

    const nowSpy = jest.spyOn(Date, 'now')
    nowSpy.mockReturnValueOnce(0)
    expect(() => cb.executeSync(() => { throw new Error('x') })).toThrow('x')
    expect(cb.getState()).toBe(CircuitState.OPEN)

    nowSpy.mockReturnValue(1000)
    expect(cb.getState()).toBe(CircuitState.HALF_OPEN)

    expect(cb.executeSync(() => 'ok')).toBe('ok')
    expect(cb.getState()).toBe(CircuitState.HALF_OPEN)
    expect(cb.executeSync(() => 'ok')).toBe('ok')
    expect(cb.getState()).toBe(CircuitState.CLOSED)

    const health = cb.getHealthInfo()
    expect(health.failureCount).toBe(0)
    expect(health.successCount).toBe(0)
  })

  it('returns to OPEN if a failure occurs in HALF_OPEN', () => {
    const cb = new CircuitBreaker('svc-basic-7', {
      failureThreshold: 2,
      timeoutMs: 1000,
      halfOpenMaxCalls: 5,
      successThreshold: 3,
      failureRateThreshold: 1,
    })

    const nowSpy = jest.spyOn(Date, 'now')
    nowSpy.mockReturnValueOnce(0)
    expect(() => cb.executeSync(() => { throw new Error('x') })).toThrow('x')
    expect(cb.getState()).toBe(CircuitState.OPEN)

    nowSpy.mockReturnValue(1000)
    expect(cb.getState()).toBe(CircuitState.HALF_OPEN)

    expect(() => cb.executeSync(() => { throw new Error('boom') })).toThrow('boom')
    expect(cb.getState()).toBe(CircuitState.OPEN)
  })

  it('decreases failureCount on success in CLOSED', () => {
    const cb = new CircuitBreaker('svc-basic-8', {
      failureThreshold: 100,
      failureRateThreshold: 1,
    })

    // Cause some failures but not enough to open
    expect(() => cb.executeSync(() => { throw new Error('x') })).toThrow('x')
    expect(() => cb.executeSync(() => { throw new Error('y') })).toThrow('y')
    expect(() => cb.executeSync(() => { throw new Error('z') })).toThrow('z')

    let health = cb.getHealthInfo()
    expect(health.state).toBe(CircuitState.CLOSED)
    expect(health.failureCount).toBe(3)

    cb.executeSync(() => 'ok')
    health = cb.getHealthInfo()
    expect(health.failureCount).toBe(2)
  })

  it('opens based on sliding window failure rate threshold', () => {
    const cb = new CircuitBreaker('svc-basic-9', {
      slidingWindowSize: 4,
      failureRateThreshold: 0.5,
      failureThreshold: 99,
    })

    expect(() => cb.executeSync(() => { throw new Error('a') })).toThrow('a')
    expect(cb.getHealthInfo().failureRate).toBeCloseTo(0.25, 5)
    expect(() => cb.executeSync(() => { throw new Error('b') })).toThrow('b')

    expect(cb.getState()).toBe(CircuitState.OPEN)
    const health = cb.getHealthInfo()
    expect(health.failureRate).toBeCloseTo(0.5, 5)
  })

  it('computes averageResponseTimeMs over calls', () => {
    const cb = new CircuitBreaker('svc-basic-10')

    const nowSpy = jest.spyOn(Date, 'now')
    // First call duration 100ms
    nowSpy.mockReturnValueOnce(1000) // start
    nowSpy.mockReturnValueOnce(1100) // end
    cb.executeSync(() => 'ok1')

    // Second call duration 200ms
    nowSpy.mockReturnValueOnce(2000) // start
    nowSpy.mockReturnValueOnce(2200) // end
    cb.executeSync(() => 'ok2')

    const avg = cb.getHealthInfo().metrics.averageResponseTimeMs
    expect(avg).toBe(150)
  })

  it('does not use fallback when operation fails while allowed', async () => {
    const cb = new CircuitBreaker('svc-basic-11', {
      failureThreshold: 2,
      failureRateThreshold: 1,
    })
    const fallback = jest.fn().mockResolvedValue('fb')
    const opFail = jest.fn().mockRejectedValue(new Error('boom'))
    await expect(cb.execute(opFail, fallback)).rejects.toThrow('boom')
    expect(fallback).not.toHaveBeenCalled()
  })

  it('executeSync increments rejectedCalls but not totalCalls when not allowed', () => {
    const cb = new CircuitBreaker('svc-basic-12', { failureThreshold: 1, failureRateThreshold: 1, timeoutMs: 10000 })
    expect(() => cb.executeSync(() => { throw new Error('x') })).toThrow('x')
    expect(cb.getState()).toBe(CircuitState.OPEN)

    const before = cb.getHealthInfo().metrics
    expect(() => cb.executeSync(() => 'ok')).toThrow(CircuitBreakerOpenError)
    const after = cb.getHealthInfo().metrics
    expect(after.rejectedCalls).toBe(before.rejectedCalls + 1)
    expect(after.totalCalls).toBe(before.totalCalls) // unchanged
  })
})

describe('CircuitBreaker registry', () => {
  it('getOrCreate returns same instance for same name', () => {
    const a = CircuitBreaker.getOrCreate('svc-reg-1', { failureThreshold: 3 })
    const b = CircuitBreaker.getOrCreate('svc-reg-1', { failureThreshold: 5 })
    expect(a).toBe(b)
    expect(a.getHealthInfo().config.failureThreshold).toBe(3)
  })

  it('getRegistry returns a copy (mutations do not affect internal registry)', () => {
    const before = CircuitBreaker.getRegistry()
    const copy = CircuitBreaker.getRegistry()
    copy.set('mutated', new CircuitBreaker('mutated'))
    const after = CircuitBreaker.getRegistry()
    expect(after.size).toBe(before.size)
    expect(after.has('mutated')).toBe(false)
  })
})

describe('DistributedCircuitBreakerClient', () => {
  const originalFetch = global.fetch as any
  const originalNodeId = process.env.NODE_ID

  beforeEach(() => {
    process.env.NODE_ID = 'node-123'
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: jest.fn().mockResolvedValue({}) })
  })

  afterEach(() => {
    jest.clearAllMocks()
    global.fetch = originalFetch
    process.env.NODE_ID = originalNodeId
    jest.useRealTimers()
  })

  it('register sends registration to coordinator', async () => {
    const client = new DistributedCircuitBreakerClient('http://coordinator')
    const breaker = new CircuitBreaker('svc-dist-1', { failureThreshold: 7, successThreshold: 2 })
    client.register(breaker)

    // registration is sent asynchronously; allow microtask
    await Promise.resolve()

    expect(global.fetch).toHaveBeenCalledWith(
      'http://coordinator/circuit-breakers/register',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: expect.any(String),
      })
    )
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body)
    expect(body).toMatchObject({
      service: 'svc-dist-1',
      node_id: 'node-123',
      failure_threshold: 7,
      success_threshold: 2,
    })
  })

  it('getAggregatedState returns data from coordinator', async () => {
    const payload = {
      service: 'svc-dist-agg',
      consensusState: CircuitState.HALF_OPEN,
      totalNodes: 3,
      healthScore: 87,
      nodeStates: { 'n1': CircuitState.OPEN },
    }
    ;(global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: jest.fn().mockResolvedValue(payload),
    })
    const client = new DistributedCircuitBreakerClient('http://coordinator')
    const resp = await client.getAggregatedState('svc-dist-agg')
    expect(resp).toEqual(payload)
    expect(global.fetch).toHaveBeenCalledWith('http://coordinator/circuit-breakers/svc-dist-agg/aggregate')
  })

  it('getAggregatedState returns default on failure', async () => {
    ;(global.fetch as jest.Mock).mockRejectedValueOnce(new Error('network'))
    const client = new DistributedCircuitBreakerClient('http://coordinator')
    const resp = await client.getAggregatedState('svc-dist-agg-fail')
    expect(resp).toEqual({
      service: 'svc-dist-agg-fail',
      consensusState: CircuitState.CLOSED,
      totalNodes: 0,
      healthScore: 0,
      nodeStates: {},
    })
  })

  it('startSync periodically reports state for registered breakers', async () => {
    jest.useFakeTimers()
    const client = new DistributedCircuitBreakerClient('http://coordinator', 1000)
    const breakerA = new CircuitBreaker('svc-dist-2A')
    const breakerB = new CircuitBreaker('svc-dist-2B')

    client.register(breakerA)
    client.register(breakerB)

    // ignore registration calls
    await Promise.resolve()
    ;(global.fetch as jest.Mock).mockClear()

    client.startSync()

    jest.advanceTimersByTime(1000)
    await Promise.resolve()

    // Two POSTs to state endpoint (one per breaker)
    const calls = (global.fetch as jest.Mock).mock.calls
    expect(calls.length).toBe(2)
    expect(calls[0][0]).toBe('http://coordinator/circuit-breakers/state')
    expect(calls[1][0]).toBe('http://coordinator/circuit-breakers/state')

    // Verify payload contains health_info and node_id
    const bodies = calls.map((c: any[]) => JSON.parse(c[1].body))
    bodies.forEach((body: any) => {
      expect(body).toHaveProperty('service')
      expect(body).toHaveProperty('node_id', 'node-123')
      expect(body).toHaveProperty('state')
      expect(body).toHaveProperty('timestamp')
      expect(body).toHaveProperty('health_info')
    })

    client.stopSync()
  })

  it('stopSync cancels further synchronization', async () => {
    jest.useFakeTimers()
    const client = new DistributedCircuitBreakerClient('http://coordinator', 500)
    const breaker = new CircuitBreaker('svc-dist-3')
    client.register(breaker)
    await Promise.resolve()
    ;(global.fetch as jest.Mock).mockClear()

    client.startSync()
    jest.advanceTimersByTime(500)
    await Promise.resolve()
    const callsAfterStart = (global.fetch as jest.Mock).mock.calls.length

    client.stopSync()
    jest.advanceTimersByTime(2000)
    await Promise.resolve()
    const callsAfterStop = (global.fetch as jest.Mock).mock.calls.length

    expect(callsAfterStart).toBeGreaterThan(0)
    expect(callsAfterStop).toBe(callsAfterStart)
  })
})

describe('withCircuitBreaker decorator', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('wraps method execution with circuit breaker and opens on failure', async () => {
    const name = 'svc-deco-1'
    class Service {
      async run(mode: string) {
        if (mode === 'fail') throw new Error('boom')
        return 'ok'
      }
    }

    const decorator = withCircuitBreaker(name, { failureThreshold: 1, failureRateThreshold: 1, timeoutMs: 10000 })
    const desc = Object.getOwnPropertyDescriptor(Service.prototype, 'run')!
    const newDesc = decorator(Service.prototype, 'run', desc)!
    Object.defineProperty(Service.prototype, 'run', newDesc)

    const s = new Service()
    await expect(s.run('ok')).resolves.toBe('ok')

    await expect(s.run('fail')).rejects.toThrow('boom')
    const breaker = CircuitBreaker.getOrCreate(name)
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    await expect(s.run('ok')).rejects.toBeInstanceOf(CircuitBreakerOpenError)
  })

  it('uses existing named breaker from registry across multiple instances', async () => {
    const name = 'svc-deco-2'
    class A {
      async doIt(flag: boolean) {
        if (!flag) throw new Error('nope')
        return 'A'
      }
    }
    class B {
      async doIt(flag: boolean) {
        if (!flag) throw new Error('nope')
        return 'B'
      }
    }

    const dec = withCircuitBreaker(name, { failureThreshold: 1, failureRateThreshold: 1, timeoutMs: 10000 })
    const da = dec(A.prototype, 'doIt', Object.getOwnPropertyDescriptor(A.prototype, 'doIt')!)
    const db = dec(B.prototype, 'doIt', Object.getOwnPropertyDescriptor(B.prototype, 'doIt')!)
    Object.defineProperty(A.prototype, 'doIt', da!)
    Object.defineProperty(B.prototype, 'doIt', db!)

    const a = new A()
    const b = new B()

    await expect(a.doIt(false)).rejects.toThrow('nope')
    const breaker = CircuitBreaker.getOrCreate(name)
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    await expect(b.doIt(true)).rejects.toBeInstanceOf(CircuitBreakerOpenError)
  })
})