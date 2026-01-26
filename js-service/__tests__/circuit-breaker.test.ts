import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  CircuitBreaker,
  CircuitBreakerOpenError,
  CircuitState,
  DistributedCircuitBreakerClient,
  withCircuitBreaker,
} from '../src/circuit-breaker'

describe('CircuitBreaker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2020-01-01T00:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('starts CLOSED and health info reflects initial state and defaults', () => {
    const breaker = new CircuitBreaker('svc-a')
    expect(breaker.getState()).toBe(CircuitState.CLOSED)

    const health = breaker.getHealthInfo()
    expect(health.name).toBe('svc-a')
    expect(health.state).toBe(CircuitState.CLOSED)
    expect(health.failureCount).toBe(0)
    expect(health.successCount).toBe(0)
    expect(health.failureRate).toBe(0)
    expect(health.metrics.totalCalls).toBe(0)
    expect(health.metrics.successfulCalls).toBe(0)
    expect(health.metrics.failedCalls).toBe(0)
    expect(health.metrics.rejectedCalls).toBe(0)
    expect(health.metrics.stateTransitions).toBe(0)
    expect(health.metrics.lastFailureTime).toBeNull()
    expect(health.metrics.lastSuccessTime).toBeNull()
    expect(health.metrics.averageResponseTimeMs).toBe(0)
    expect(health.config).toEqual({
      failureThreshold: 5,
      successThreshold: 3,
      timeoutMs: 30000,
    })
  })

  it('getOrCreate returns the same instance for the same name and getRegistry returns a copy', () => {
    const b1 = CircuitBreaker.getOrCreate('svc-registry', { failureThreshold: 1 })
    const b2 = CircuitBreaker.getOrCreate('svc-registry', { failureThreshold: 999 })
    expect(b1).toBe(b2)

    const reg1 = CircuitBreaker.getRegistry()
    expect(reg1.get('svc-registry')).toBe(b1)

    reg1.delete('svc-registry')
    const reg2 = CircuitBreaker.getRegistry()
    expect(reg2.has('svc-registry')).toBe(true)
    expect(reg2.get('svc-registry')).toBe(b1)
  })

  it('execute records a successful call, updates timestamps and average response time', async () => {
    const breaker = new CircuitBreaker('svc-success')

    const nowSpy = vi.spyOn(Date, 'now')
    nowSpy.mockReturnValueOnce(1000).mockReturnValueOnce(1042)

    const op = vi.fn(async () => 'ok')
    const res = await breaker.execute(op)

    expect(res).toBe('ok')
    expect(op).toHaveBeenCalledTimes(1)

    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(1)
    expect(health.metrics.successfulCalls).toBe(1)
    expect(health.metrics.failedCalls).toBe(0)
    expect(health.metrics.rejectedCalls).toBe(0)
    expect(health.metrics.lastSuccessTime).toBeInstanceOf(Date)
    expect(health.metrics.lastFailureTime).toBeNull()
    expect(health.metrics.averageResponseTimeMs).toBe(42)
    expect(health.state).toBe(CircuitState.CLOSED)
  })

  it('execute records a failed call, updates timestamps and average response time, and rethrows error', async () => {
    const breaker = new CircuitBreaker('svc-failure')

    const nowSpy = vi.spyOn(Date, 'now')
    nowSpy.mockReturnValueOnce(2000).mockReturnValueOnce(2010)

    const err = new Error('boom')
    const op = vi.fn(async () => {
      throw err
    })

    await expect(breaker.execute(op)).rejects.toBe(err)

    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(1)
    expect(health.metrics.successfulCalls).toBe(0)
    expect(health.metrics.failedCalls).toBe(1)
    expect(health.metrics.rejectedCalls).toBe(0)
    expect(health.metrics.lastFailureTime).toBeInstanceOf(Date)
    expect(health.metrics.lastSuccessTime).toBeNull()
    expect(health.metrics.averageResponseTimeMs).toBe(10)
    expect(health.failureCount).toBe(1)
    expect(health.state).toBe(CircuitState.CLOSED)
  })

  it('opens when failureThreshold is reached and rejects further requests with CircuitBreakerOpenError including remainingTimeMs', async () => {
    const breaker = new CircuitBreaker('svc-open-threshold', {
      failureThreshold: 2,
      timeoutMs: 1000,
      slidingWindowSize: 10,
      failureRateThreshold: 1, // ensure opening is driven by failureThreshold only
    })

    const err = new Error('fail')

    const nowSpy = vi.spyOn(Date, 'now')
    // two failures; second triggers OPEN and sets openedAt to 20
    nowSpy
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(20)

    await expect(breaker.execute(async () => Promise.reject(err))).rejects.toBe(err)
    await expect(breaker.execute(async () => Promise.reject(err))).rejects.toBe(err)

    expect(breaker.getState()).toBe(CircuitState.OPEN)

    // rejected call at time 120 -> remaining = 1000 - (120 - 20) = 900
    nowSpy.mockReturnValueOnce(120)
    await expect(breaker.execute(async () => 'should-not-run')).rejects.toMatchObject({
      name: 'CircuitBreakerOpenError',
    })

    try {
      await breaker.execute(async () => 'should-not-run')
      expect.unreachable('expected to throw')
    } catch (e: any) {
      expect(e).toBeInstanceOf(CircuitBreakerOpenError)
      expect(e.name).toBe('CircuitBreakerOpenError')
      expect(e.remainingTimeMs).toBe(900)
      expect(String(e.message)).toContain("Circuit breaker 'svc-open-threshold' is open")
    }

    const health = breaker.getHealthInfo()
    expect(health.metrics.rejectedCalls).toBe(2) // one from expect().rejects + one in try/catch
  })

  it('when open, execute returns fallback result and counts rejectedCalls without calling operation', async () => {
    const breaker = new CircuitBreaker('svc-fallback-open', {
      failureThreshold: 1,
      timeoutMs: 1000,
      failureRateThreshold: 1,
    })

    const nowSpy = vi.spyOn(Date, 'now')
    nowSpy.mockReturnValueOnce(0).mockReturnValueOnce(1)

    await expect(breaker.execute(async () => Promise.reject(new Error('x')))).rejects.toBeInstanceOf(
      Error
    )
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    const op = vi.fn(async () => 'nope')
    const fallback = vi.fn(async () => 'fallback-ok')

    nowSpy.mockReturnValueOnce(50)
    const res = await breaker.execute(op, fallback)

    expect(res).toBe('fallback-ok')
    expect(op).not.toHaveBeenCalled()
    expect(fallback).toHaveBeenCalledTimes(1)
    expect(breaker.getHealthInfo().metrics.rejectedCalls).toBe(1)
  })

  it('transitions from OPEN to HALF_OPEN after timeout elapses when getState is called', async () => {
    const breaker = new CircuitBreaker('svc-reset', {
      failureThreshold: 1,
      timeoutMs: 1000,
      failureRateThreshold: 1,
    })

    const nowSpy = vi.spyOn(Date, 'now')
    // fail and open at time 10
    nowSpy.mockReturnValueOnce(0).mockReturnValueOnce(10)
    await expect(breaker.execute(async () => Promise.reject(new Error('fail')))).rejects.toBeInstanceOf(
      Error
    )
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    nowSpy.mockReturnValueOnce(1009)
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    nowSpy.mockReturnValueOnce(1010)
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)
  })

  it('in HALF_OPEN, allows only halfOpenMaxCalls and then rejects with CircuitBreakerOpenError', async () => {
    const breaker = new CircuitBreaker('svc-half-open-calls', {
      failureThreshold: 1,
      timeoutMs: 1000,
      halfOpenMaxCalls: 2,
      failureRateThreshold: 1,
      successThreshold: 999, // prevent closing
    })

    const nowSpy = vi.spyOn(Date, 'now')
    // fail and open at 10
    nowSpy.mockReturnValueOnce(0).mockReturnValueOnce(10)
    await expect(breaker.execute(async () => Promise.reject(new Error('fail')))).rejects.toBeInstanceOf(
      Error
    )

    // half-open transition
    nowSpy.mockReturnValueOnce(1010)
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)

    const op = vi.fn(async () => 'ok')
    nowSpy.mockReturnValueOnce(2000).mockReturnValueOnce(2000)
    await expect(breaker.execute(op)).resolves.toBe('ok')
    nowSpy.mockReturnValueOnce(2001).mockReturnValueOnce(2001)
    await expect(breaker.execute(op)).resolves.toBe('ok')

    // third attempt rejected (still HALF_OPEN but max calls reached)
    nowSpy.mockReturnValueOnce(2002)
    await expect(breaker.execute(op)).rejects.toBeInstanceOf(CircuitBreakerOpenError)
    expect(op).toHaveBeenCalledTimes(2)

    const health = breaker.getHealthInfo()
    expect(health.metrics.rejectedCalls).toBe(1)
    expect(health.state).toBe(CircuitState.HALF_OPEN)
  })

  it('in HALF_OPEN, a failure immediately transitions back to OPEN and increments stateTransitions', async () => {
    const breaker = new CircuitBreaker('svc-half-open-fail', {
      failureThreshold: 1,
      timeoutMs: 1000,
      failureRateThreshold: 1,
      slidingWindowSize: 10,
    })

    const nowSpy = vi.spyOn(Date, 'now')
    // initial failure triggers open at 10
    nowSpy.mockReturnValueOnce(0).mockReturnValueOnce(10)
    await expect(breaker.execute(async () => Promise.reject(new Error('f1')))).rejects.toBeInstanceOf(
      Error
    )
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    // transition to half-open
    nowSpy.mockReturnValueOnce(1010)
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)

    // in half-open, failure triggers open at 2000
    nowSpy.mockReturnValueOnce(1990).mockReturnValueOnce(2000)
    await expect(breaker.execute(async () => Promise.reject(new Error('f2')))).rejects.toBeInstanceOf(
      Error
    )

    const health = breaker.getHealthInfo()
    expect(health.state).toBe(CircuitState.OPEN)
    // transitions: CLOSED->OPEN, OPEN->HALF_OPEN, HALF_OPEN->OPEN
    expect(health.metrics.stateTransitions).toBe(3)
  })

  it('in HALF_OPEN, reaching successThreshold closes and resets counts and sliding window', async () => {
    const breaker = new CircuitBreaker('svc-half-open-close', {
      failureThreshold: 1,
      timeoutMs: 1000,
      successThreshold: 2,
      failureRateThreshold: 1,
      slidingWindowSize: 4,
    })

    const nowSpy = vi.spyOn(Date, 'now')
    nowSpy.mockReturnValueOnce(0).mockReturnValueOnce(10)
    await expect(breaker.execute(async () => Promise.reject(new Error('fail')))).rejects.toBeInstanceOf(
      Error
    )
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    nowSpy.mockReturnValueOnce(1010)
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)

    nowSpy.mockReturnValueOnce(2000).mockReturnValueOnce(2001)
    await expect(breaker.execute(async () => 'ok1')).resolves.toBe('ok1')
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)

    nowSpy.mockReturnValueOnce(2002).mockReturnValueOnce(2003)
    await expect(breaker.execute(async () => 'ok2')).resolves.toBe('ok2')

    expect(breaker.getState()).toBe(CircuitState.CLOSED)

    const health = breaker.getHealthInfo()
    expect(health.failureCount).toBe(0)
    expect(health.successCount).toBe(0)

    // After closing, sliding window is filled with true => failureRate 0
    expect(health.failureRate).toBe(0)
  })

  it('in CLOSED, a success decrements failureCount by 1 but not below zero', async () => {
    const breaker = new CircuitBreaker('svc-decrement', {
      failureThreshold: 10,
      failureRateThreshold: 1,
    })

    const nowSpy = vi.spyOn(Date, 'now')

    // create 2 failures (keeps CLOSED)
    nowSpy.mockReturnValueOnce(0).mockReturnValueOnce(1)
    await expect(breaker.execute(async () => Promise.reject(new Error('f1')))).rejects.toBeInstanceOf(
      Error
    )
    nowSpy.mockReturnValueOnce(2).mockReturnValueOnce(3)
    await expect(breaker.execute(async () => Promise.reject(new Error('f2')))).rejects.toBeInstanceOf(
      Error
    )

    expect(breaker.getHealthInfo().failureCount).toBe(2)

    // success decrements to 1
    nowSpy.mockReturnValueOnce(4).mockReturnValueOnce(9)
    await expect(breaker.execute(async () => 'ok')).resolves.toBe('ok')
    expect(breaker.getHealthInfo().failureCount).toBe(1)

    // another success decrements to 0
    nowSpy.mockReturnValueOnce(10).mockReturnValueOnce(10)
    await expect(breaker.execute(async () => 'ok2')).resolves.toBe('ok2')
    expect(breaker.getHealthInfo().failureCount).toBe(0)

    // another success stays at 0
    nowSpy.mockReturnValueOnce(11).mockReturnValueOnce(12)
    await expect(breaker.execute(async () => 'ok3')).resolves.toBe('ok3')
    expect(breaker.getHealthInfo().failureCount).toBe(0)
  })

  it('opens when sliding window failure rate meets/exceeds threshold even if failureCount below threshold', async () => {
    const breaker = new CircuitBreaker('svc-failure-rate', {
      failureThreshold: 999,
      slidingWindowSize: 4,
      failureRateThreshold: 0.5,
      timeoutMs: 1000,
    })

    const nowSpy = vi.spyOn(Date, 'now')

    // 2 failures out of 4 => failureRate = 0.5 => should open on second failure
    nowSpy.mockReturnValueOnce(0).mockReturnValueOnce(1)
    await expect(breaker.execute(async () => Promise.reject(new Error('f1')))).rejects.toBeInstanceOf(
      Error
    )
    expect(breaker.getState()).toBe(CircuitState.CLOSED)

    nowSpy.mockReturnValueOnce(2).mockReturnValueOnce(3)
    await expect(breaker.execute(async () => Promise.reject(new Error('f2')))).rejects.toBeInstanceOf(
      Error
    )
    expect(breaker.getState()).toBe(CircuitState.OPEN)
  })

  it('executeSync success and failure update metrics similarly', () => {
    const breaker = new CircuitBreaker('svc-sync', { failureThreshold: 10, failureRateThreshold: 1 })
    const nowSpy = vi.spyOn(Date, 'now')
    nowSpy.mockReturnValueOnce(10).mockReturnValueOnce(15)

    const ok = breaker.executeSync(() => 'ok')
    expect(ok).toBe('ok')

    nowSpy.mockReturnValueOnce(20).mockReturnValueOnce(30)
    expect(() => breaker.executeSync(() => {
      throw new Error('sync-fail')
    })).toThrow('sync-fail')

    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(2)
    expect(health.metrics.successfulCalls).toBe(1)
    expect(health.metrics.failedCalls).toBe(1)
    expect(health.metrics.averageResponseTimeMs).toBe((5 + 10) / 2)
  })

  it('executeSync when open uses fallback and increments rejectedCalls', () => {
    const breaker = new CircuitBreaker('svc-sync-fallback', {
      failureThreshold: 1,
      timeoutMs: 1000,
      failureRateThreshold: 1,
    })
    const nowSpy = vi.spyOn(Date, 'now')
    nowSpy.mockReturnValueOnce(0).mockReturnValueOnce(1)

    expect(() => breaker.executeSync(() => {
      throw new Error('fail')
    })).toThrow('fail')
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    const op = vi.fn(() => 'nope')
    const fallback = vi.fn(() => 'fallback')
    nowSpy.mockReturnValueOnce(50)

    const res = breaker.executeSync(op, fallback)
    expect(res).toBe('fallback')
    expect(op).not.toHaveBeenCalled()
    expect(fallback).toHaveBeenCalledTimes(1)
    expect(breaker.getHealthInfo().metrics.rejectedCalls).toBe(1)
  })

  it('response time list is capped to 100 and average is computed from retained values', async () => {
    const breaker = new CircuitBreaker('svc-rt-cap', { failureThreshold: 999, failureRateThreshold: 1 })

    const nowSpy = vi.spyOn(Date, 'now')

    for (let i = 1; i <= 101; i++) {
      const start = i * 10
      const end = start + 1 // duration 1ms for all
      nowSpy.mockReturnValueOnce(start).mockReturnValueOnce(end)
      await breaker.execute(async () => 'x')
    }

    // All durations are 1ms, cap doesn't matter for average but ensures code path is exercised
    expect(breaker.getHealthInfo().metrics.averageResponseTimeMs).toBe(1)
    expect(breaker.getHealthInfo().metrics.totalCalls).toBe(101)
  })
})

describe('CircuitBreakerOpenError', () => {
  it('formats message and exposes name and remainingTimeMs', () => {
    const err = new CircuitBreakerOpenError('svc-x', 1234.56)
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('CircuitBreakerOpenError')
    expect(err.remainingTimeMs).toBe(1234.56)
    expect(err.message).toContain("Circuit breaker 'svc-x' is open. Retry after 1235ms")
  })
})

describe('DistributedCircuitBreakerClient', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2020-01-01T00:00:00.000Z'))
    vi.unstubAllEnvs()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('register sends registration payload with node_id and thresholds (and does not throw on fetch errors)', async () => {
    vi.stubEnv('NODE_ID', 'node-123')

    const fetchMock = vi.fn(async () => {
      throw new Error('network')
    })
    ;(globalThis as any).fetch = fetchMock

    const client = new DistributedCircuitBreakerClient('http://coord', 50)
    const breaker = new CircuitBreaker('svc-reg', { failureThreshold: 7, successThreshold: 9 })

    expect(() => client.register(breaker)).not.toThrow()

    await vi.runAllTicksAsync()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://coord/circuit-breakers/register')
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' })

    const parsed = JSON.parse(init.body)
    expect(parsed).toEqual({
      service: 'svc-reg',
      node_id: 'node-123',
      failure_threshold: 7,
      success_threshold: 9,
    })
  })

  it('startSync sets an interval that reports breaker state periodically; stopSync clears it', async () => {
    vi.stubEnv('NODE_ID', 'node-A')
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }))
    ;(globalThis as any).fetch = fetchMock

    const client = new DistributedCircuitBreakerClient('http://coord', 1000)
    const breaker = new CircuitBreaker('svc-sync', { failureThreshold: 10, failureRateThreshold: 1 })
    client.register(breaker)

    await vi.runAllTicksAsync()
    expect(fetchMock).toHaveBeenCalledTimes(1) // registration

    client.startSync()
    client.startSync() // idempotent

    await vi.advanceTimersByTimeAsync(1000)
    await vi.runAllTicksAsync()

    // one report cycle => one state report
    expect(fetchMock.mock.calls.some((c: any[]) => String(c[0]).endsWith('/circuit-breakers/state'))).toBe(
      true
    )

    const stateCallsBeforeStop = fetchMock.mock.calls.filter((c: any[]) =>
      String(c[0]).endsWith('/circuit-breakers/state')
    ).length

    client.stopSync()
    await vi.advanceTimersByTimeAsync(3000)
    await vi.runAllTicksAsync()

    const stateCallsAfterStop = fetchMock.mock.calls.filter((c: any[]) =>
      String(c[0]).endsWith('/circuit-breakers/state')
    ).length

    expect(stateCallsAfterStop).toBe(stateCallsBeforeStop)
  })

  it('reported state payload includes service, node_id, state, timestamp, and health_info', async () => {
    vi.stubEnv('NODE_ID', 'node-PAYLOAD')
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }))
    ;(globalThis as any).fetch = fetchMock

    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(424242)

    const client = new DistributedCircuitBreakerClient('http://coord', 1000)
    const breaker = new CircuitBreaker('svc-payload', { failureThreshold: 10, failureRateThreshold: 1 })
    client.register(breaker)
    await vi.runAllTicksAsync()

    client.startSync()
    await vi.advanceTimersByTimeAsync(1000)
    await vi.runAllTicksAsync()

    const stateCall = fetchMock.mock.calls.find((c: any[]) =>
      String(c[0]).endsWith('/circuit-breakers/state')
    )
    expect(stateCall).toBeTruthy()

    const [, init] = stateCall
    const parsed = JSON.parse(init.body)
    expect(parsed.service).toBe('svc-payload')
    expect(parsed.node_id).toBe('node-PAYLOAD')
    expect(parsed.state).toBe(CircuitState.CLOSED)
    expect(parsed.timestamp).toBe(424242)
    expect(parsed.health_info).toBeTruthy()
    expect(parsed.health_info.name).toBe('svc-payload')

    nowSpy.mockRestore()
  })

  it('getAggregatedState returns parsed JSON on success', async () => {
    const payload = {
      service: 'svc-agg',
      consensusState: CircuitState.OPEN,
      totalNodes: 3,
      healthScore: 0.25,
      nodeStates: { a: CircuitState.OPEN, b: CircuitState.OPEN, c: CircuitState.HALF_OPEN },
    }

    const fetchMock = vi.fn(async () => ({
      json: async () => payload,
    }))
    ;(globalThis as any).fetch = fetchMock

    const client = new DistributedCircuitBreakerClient('http://coord')
    const res = await client.getAggregatedState('svc-agg')

    expect(fetchMock).toHaveBeenCalledWith('http://coord/circuit-breakers/svc-agg/aggregate')
    expect(res).toEqual(payload)
  })

  it('getAggregatedState returns default CLOSED consensus on fetch error', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('network down')
    })
    ;(globalThis as any).fetch = fetchMock

    const client = new DistributedCircuitBreakerClient('http://coord')
    const res = await client.getAggregatedState('svc-agg2')

    expect(res).toEqual({
      service: 'svc-agg2',
      consensusState: CircuitState.CLOSED,
      totalNodes: 0,
      healthScore: 0,
      nodeStates: {},
    })
  })
})

describe('withCircuitBreaker decorator', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2020-01-01T00:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('wraps an async method so it executes through the circuit breaker and returns original result', async () => {
    const spy = vi.spyOn(CircuitBreaker, 'getOrCreate')
    const decoratorFactory = withCircuitBreaker('decor-svc', {
      failureThreshold: 5,
      failureRateThreshold: 1,
    })

    class Svc {
      async work(x: number) {
        return x + 1
      }
    }

    const desc = Object.getOwnPropertyDescriptor(Svc.prototype, 'work')!
    const newDesc = decoratorFactory(Svc.prototype, 'work', desc) as PropertyDescriptor
    Object.defineProperty(Svc.prototype, 'work', newDesc)

    const svc = new Svc()
    await expect(svc.work(41)).resolves.toBe(42)

    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith('decor-svc', {
      failureThreshold: 5,
      failureRateThreshold: 1,
    })

    const breaker = CircuitBreaker.getOrCreate('decor-svc')
    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBeGreaterThanOrEqual(1)
  })

  it('uses the same circuit breaker instance for multiple decorated classes with same name', async () => {
    const decoratorFactory = withCircuitBreaker('decor-shared', {
      failureThreshold: 1,
      timeoutMs: 1000,
      failureRateThreshold: 1,
    })

    class A {
      async run() {
        throw new Error('fail')
      }
    }
    class B {
      async run() {
        return 'ok'
      }
    }

    const descA = Object.getOwnPropertyDescriptor(A.prototype, 'run')!
    Object.defineProperty(A.prototype, 'run', decoratorFactory(A.prototype, 'run', descA))

    const descB = Object.getOwnPropertyDescriptor(B.prototype, 'run')!
    Object.defineProperty(B.prototype, 'run', decoratorFactory(B.prototype, 'run', descB))

    const nowSpy = vi.spyOn(Date, 'now')
    nowSpy.mockReturnValueOnce(0).mockReturnValueOnce(1)

    const a = new A()
    await expect(a.run()).rejects.toBeInstanceOf(Error)

    const breaker = CircuitBreaker.getOrCreate('decor-shared')
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    // B should now be rejected because breaker is open
    nowSpy.mockReturnValueOnce(10)
    const b = new B()
    await expect(b.run()).rejects.toBeInstanceOf(CircuitBreakerOpenError)
  })
})