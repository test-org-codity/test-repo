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

  it('starts in CLOSED state with healthy sliding window resulting in failureRate 0', () => {
    const cb = new CircuitBreaker('svc-a')
    const info = cb.getHealthInfo()
    expect(info.name).toBe('svc-a')
    expect(info.state).toBe(CircuitState.CLOSED)
    expect(info.failureRate).toBe(0)
    expect(info.failureCount).toBe(0)
    expect(info.successCount).toBe(0)
    expect(info.metrics.totalCalls).toBe(0)
    expect(info.metrics.averageResponseTimeMs).toBe(0)
  })

  it('execute records success metrics and response time average', async () => {
    const cb = new CircuitBreaker('svc-b')
    const op = vi.fn(async () => {
      vi.advanceTimersByTime(25)
      return 'ok'
    })

    const p = cb.execute(op)
    await vi.runAllTimersAsync()
    const result = await p

    expect(result).toBe('ok')
    const info = cb.getHealthInfo()
    expect(op).toHaveBeenCalledTimes(1)
    expect(info.metrics.totalCalls).toBe(1)
    expect(info.metrics.successfulCalls).toBe(1)
    expect(info.metrics.failedCalls).toBe(0)
    expect(info.metrics.lastSuccessTime).toBeInstanceOf(Date)
    expect(info.metrics.averageResponseTimeMs).toBe(25)
  })

  it('execute records failure metrics, rethrows original error, and updates average response time', async () => {
    const cb = new CircuitBreaker('svc-c')
    const err = new Error('boom')
    const op = vi.fn(async () => {
      vi.advanceTimersByTime(10)
      throw err
    })

    const p = cb.execute(op)
    await vi.runAllTimersAsync()

    await expect(p).rejects.toBe(err)

    const info = cb.getHealthInfo()
    expect(info.metrics.totalCalls).toBe(1)
    expect(info.metrics.successfulCalls).toBe(0)
    expect(info.metrics.failedCalls).toBe(1)
    expect(info.metrics.lastFailureTime).toBeInstanceOf(Date)
    expect(info.metrics.averageResponseTimeMs).toBe(10)
  })

  it('executeSync records success and returns value', () => {
    const cb = new CircuitBreaker('svc-d')
    const op = vi.fn(() => {
      vi.advanceTimersByTime(7)
      return 123
    })

    const result = cb.executeSync(op)

    expect(result).toBe(123)
    const info = cb.getHealthInfo()
    expect(info.metrics.totalCalls).toBe(1)
    expect(info.metrics.successfulCalls).toBe(1)
    expect(info.metrics.failedCalls).toBe(0)
    expect(info.metrics.averageResponseTimeMs).toBe(7)
  })

  it('executeSync records failure and rethrows', () => {
    const cb = new CircuitBreaker('svc-e')
    const err = new Error('sync boom')
    const op = vi.fn(() => {
      vi.advanceTimersByTime(4)
      throw err
    })

    expect(() => cb.executeSync(op)).toThrow(err)

    const info = cb.getHealthInfo()
    expect(info.metrics.totalCalls).toBe(1)
    expect(info.metrics.failedCalls).toBe(1)
    expect(info.metrics.averageResponseTimeMs).toBe(4)
  })

  it('opens when failureThreshold reached and rejects subsequent calls with CircuitBreakerOpenError including remainingTimeMs', async () => {
    const cb = new CircuitBreaker('svc-f', { failureThreshold: 2, timeoutMs: 1000 })

    const failOp = vi.fn(async () => {
      vi.advanceTimersByTime(1)
      throw new Error('fail')
    })

    // Trip to OPEN
    let p = cb.execute(failOp)
    await vi.runAllTimersAsync()
    await expect(p).rejects.toBeInstanceOf(Error)

    p = cb.execute(failOp)
    await vi.runAllTimersAsync()
    await expect(p).rejects.toBeInstanceOf(Error)

    expect(cb.getState()).toBe(CircuitState.OPEN)

    // Rejected while OPEN
    const before = cb.getHealthInfo().metrics.rejectedCalls
    const rejected = cb.execute(async () => 'nope')
    await expect(rejected).rejects.toBeInstanceOf(CircuitBreakerOpenError)
    const err = await rejected.catch((e) => e as CircuitBreakerOpenError)

    expect(err).toBeInstanceOf(CircuitBreakerOpenError)
    expect(err.name).toBe('CircuitBreakerOpenError')
    expect(err.remainingTimeMs).toBeGreaterThanOrEqual(0)

    const after = cb.getHealthInfo().metrics.rejectedCalls
    expect(after).toBe(before + 1)
  })

  it('when OPEN and fallback provided, returns fallback result and increments rejectedCalls', async () => {
    const cb = new CircuitBreaker('svc-g', { failureThreshold: 1, timeoutMs: 1000 })
    await expect(
      (async () => {
        const p = cb.execute(async () => {
          throw new Error('fail once')
        })
        await vi.runAllTimersAsync()
        return p
      })()
    ).rejects.toBeInstanceOf(Error)

    expect(cb.getState()).toBe(CircuitState.OPEN)

    const fallback = vi.fn(async () => 'fallback-ok')
    const op = vi.fn(async () => 'should-not-run')

    const before = cb.getHealthInfo().metrics.rejectedCalls
    const result = await cb.execute(op, fallback)

    expect(result).toBe('fallback-ok')
    expect(op).not.toHaveBeenCalled()
    expect(fallback).toHaveBeenCalledTimes(1)
    expect(cb.getHealthInfo().metrics.rejectedCalls).toBe(before + 1)
  })

  it('transitions to HALF_OPEN after timeoutMs when getState is called, and allows up to halfOpenMaxCalls', async () => {
    const cb = new CircuitBreaker('svc-h', {
      failureThreshold: 1,
      timeoutMs: 1000,
      halfOpenMaxCalls: 2,
      successThreshold: 10,
    })

    // Trip open
    const p = cb.execute(async () => {
      throw new Error('fail')
    })
    await vi.runAllTimersAsync()
    await expect(p).rejects.toBeInstanceOf(Error)
    expect(cb.getState()).toBe(CircuitState.OPEN)

    // Not yet timed out -> still open
    vi.advanceTimersByTime(999)
    expect(cb.getState()).toBe(CircuitState.OPEN)

    // Timed out -> HALF_OPEN
    vi.advanceTimersByTime(1)
    expect(cb.getState()).toBe(CircuitState.HALF_OPEN)

    const op = vi.fn(async () => 'ok')
    const r1 = await cb.execute(op)
    const r2 = await cb.execute(op)
    expect(r1).toBe('ok')
    expect(r2).toBe('ok')
    expect(op).toHaveBeenCalledTimes(2)

    // third call rejected (still HALF_OPEN, over limit)
    const fallback = vi.fn(async () => 'fb')
    const beforeRejected = cb.getHealthInfo().metrics.rejectedCalls
    const r3 = await cb.execute(op, fallback)
    expect(r3).toBe('fb')
    expect(cb.getHealthInfo().metrics.rejectedCalls).toBe(beforeRejected + 1)
  })

  it('in HALF_OPEN, reaching successThreshold closes the circuit and resets failureCount/successCount/openedAt/windowIndex', async () => {
    const cb = new CircuitBreaker('svc-i', {
      failureThreshold: 1,
      timeoutMs: 1000,
      successThreshold: 2,
      slidingWindowSize: 4,
      halfOpenMaxCalls: 3,
    })

    const fail = cb.execute(async () => {
      throw new Error('fail')
    })
    await vi.runAllTimersAsync()
    await expect(fail).rejects.toBeInstanceOf(Error)
    expect(cb.getState()).toBe(CircuitState.OPEN)

    vi.advanceTimersByTime(1000)
    expect(cb.getState()).toBe(CircuitState.HALF_OPEN)

    await cb.execute(async () => 'ok1')
    expect(cb.getState()).toBe(CircuitState.HALF_OPEN)

    await cb.execute(async () => 'ok2')
    expect(cb.getState()).toBe(CircuitState.CLOSED)

    const info = cb.getHealthInfo()
    expect(info.failureCount).toBe(0)
    expect(info.successCount).toBe(0)
    expect(info.metrics.stateTransitions).toBe(2) // CLOSED->OPEN, OPEN->HALF_OPEN, HALF_OPEN->CLOSED actually 3? But initial CLOSED to OPEN (1), OPEN to HALF_OPEN (2), HALF_OPEN to CLOSED (3)
    // Use actual: ensure at least 2, and exactly 3 given path.
    expect(info.metrics.stateTransitions).toBe(3)
    expect(info.failureRate).toBe(0)
  })

  it('in HALF_OPEN, a failure immediately transitions back to OPEN', async () => {
    const cb = new CircuitBreaker('svc-j', {
      failureThreshold: 1,
      timeoutMs: 1000,
      successThreshold: 2,
    })

    const fail = cb.execute(async () => {
      throw new Error('fail')
    })
    await vi.runAllTimersAsync()
    await expect(fail).rejects.toBeInstanceOf(Error)

    vi.advanceTimersByTime(1000)
    expect(cb.getState()).toBe(CircuitState.HALF_OPEN)

    const failHalfOpen = cb.execute(async () => {
      throw new Error('nope')
    })
    await vi.runAllTimersAsync()
    await expect(failHalfOpen).rejects.toBeInstanceOf(Error)

    expect(cb.getState()).toBe(CircuitState.OPEN)
  })

  it('uses failureRateThreshold based on sliding window to open even before failureThreshold', async () => {
    const cb = new CircuitBreaker('svc-k', {
      slidingWindowSize: 4,
      failureThreshold: 10,
      failureRateThreshold: 0.5,
    })

    const ok = () => cb.execute(async () => 'ok')
    const fail = async () => {
      const p = cb.execute(async () => {
        throw new Error('fail')
      })
      await vi.runAllTimersAsync()
      await p
    }

    // 2 successes
    await ok()
    await ok()

    // 2 failures -> failure rate 0.5 -> OPEN (threshold is >= 0.5)
    await expect(fail()).rejects.toBeInstanceOf(Error)
    await expect(fail()).rejects.toBeInstanceOf(Error)

    expect(cb.getState()).toBe(CircuitState.OPEN)
  })

  it('recordSuccess in CLOSED decrements failureCount but not below zero', async () => {
    const cb = new CircuitBreaker('svc-l', { failureThreshold: 100, failureRateThreshold: 1, slidingWindowSize: 10 })

    // make 2 failures but keep CLOSED due to thresholds
    const f1 = cb.execute(async () => {
      throw new Error('f')
    })
    await vi.runAllTimersAsync()
    await expect(f1).rejects.toBeInstanceOf(Error)

    const f2 = cb.execute(async () => {
      throw new Error('f')
    })
    await vi.runAllTimersAsync()
    await expect(f2).rejects.toBeInstanceOf(Error)

    expect(cb.getState()).toBe(CircuitState.CLOSED)
    expect(cb.getHealthInfo().failureCount).toBe(2)

    await cb.execute(async () => 'ok')
    expect(cb.getHealthInfo().failureCount).toBe(1)

    await cb.execute(async () => 'ok')
    expect(cb.getHealthInfo().failureCount).toBe(0)

    await cb.execute(async () => 'ok')
    expect(cb.getHealthInfo().failureCount).toBe(0)
  })

  it('keeps only the last 100 response times when computing averageResponseTimeMs', async () => {
    const cb = new CircuitBreaker('svc-m')

    for (let i = 1; i <= 105; i++) {
      const dur = i
      const p = cb.execute(async () => {
        vi.advanceTimersByTime(dur)
        return i
      })
      await vi.runAllTimersAsync()
      await p
    }

    const info = cb.getHealthInfo()
    // last 100 are 6..105, average is (6+105)/2 = 55.5
    expect(info.metrics.totalCalls).toBe(105)
    expect(info.metrics.successfulCalls).toBe(105)
    expect(info.metrics.averageResponseTimeMs).toBe(55.5)
  })

  it('CircuitBreaker.getOrCreate returns same instance for same name and getRegistry returns a copy', () => {
    const a1 = CircuitBreaker.getOrCreate('svc-n', { failureThreshold: 1 })
    const a2 = CircuitBreaker.getOrCreate('svc-n', { failureThreshold: 999 })
    expect(a1).toBe(a2)

    const reg1 = CircuitBreaker.getRegistry()
    expect(reg1.get('svc-n')).toBe(a1)

    reg1.delete('svc-n')
    const reg2 = CircuitBreaker.getRegistry()
    expect(reg2.has('svc-n')).toBe(true)
  })

  it('getHealthInfo exposes only selected config keys (failureThreshold, successThreshold, timeoutMs)', () => {
    const cb = new CircuitBreaker('svc-o', {
      failureThreshold: 2,
      successThreshold: 4,
      timeoutMs: 123,
      halfOpenMaxCalls: 9,
      slidingWindowSize: 77,
      failureRateThreshold: 0.9,
    })
    const cfg = cb.getHealthInfo().config as any
    expect(cfg.failureThreshold).toBe(2)
    expect(cfg.successThreshold).toBe(4)
    expect(cfg.timeoutMs).toBe(123)
    expect(cfg.halfOpenMaxCalls).toBeUndefined()
    expect(cfg.slidingWindowSize).toBeUndefined()
    expect(cfg.failureRateThreshold).toBeUndefined()
  })
})

describe('CircuitBreakerOpenError', () => {
  it('sets message, error name, and remainingTimeMs', () => {
    const e = new CircuitBreakerOpenError('svc-p', 1234.56)
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe('CircuitBreakerOpenError')
    expect(e.remainingTimeMs).toBe(1234.56)
    expect(e.message).toContain("Circuit breaker 'svc-p' is open.")
    expect(e.message).toContain('Retry after')
  })
})

describe('withCircuitBreaker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2020-01-01T00:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('wraps a method so calls are routed through breaker.execute and failures can open circuit', async () => {
    class Svc {
      calls = 0
      async work(shouldFail: boolean) {
        this.calls++
        if (shouldFail) throw new Error('nope')
        return 'ok'
      }
    }

    const descriptor = Object.getOwnPropertyDescriptor(Svc.prototype, 'work')!
    const decorated = withCircuitBreaker('decor-svc', { failureThreshold: 1, timeoutMs: 1000 })(
      Svc.prototype,
      'work',
      descriptor
    )

    Object.defineProperty(Svc.prototype, 'work', decorated)

    const s = new Svc()

    const p1 = (s as any).work(true)
    await expect(p1).rejects.toBeInstanceOf(Error)

    // now open => rejected
    const p2 = (s as any).work(false)
    await expect(p2).rejects.toBeInstanceOf(CircuitBreakerOpenError)

    // original method should have only run once (first call); second is blocked by breaker
    expect(s.calls).toBe(1)
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
    vi.unstubAllEnvs()
  })

  it('register() sends registration payload (service, node_id, thresholds)', async () => {
    vi.stubEnv('NODE_ID', 'node-1')

    const fetchMock = vi.fn(async () => ({ json: vi.fn(async () => ({})) }) as any)
    ;(globalThis as any).fetch = fetchMock

    const client = new DistributedCircuitBreakerClient('http://coord')
    const breaker = new CircuitBreaker('svc-q', { failureThreshold: 7, successThreshold: 9 })

    client.register(breaker)

    // sendRegistration is async and intentionally swallowed; flush microtasks
    await Promise.resolve()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://coord/circuit-breakers/register')
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' })

    const body = JSON.parse(init.body as string)
    expect(body.service).toBe('svc-q')
    expect(body.node_id).toBe('node-1')
    expect(body.failure_threshold).toBe(7)
    expect(body.success_threshold).toBe(9)
  })

  it('startSync() schedules reporting and stopSync() cancels it', async () => {
    vi.stubEnv('NODE_ID', 'node-2')

    const fetchMock = vi.fn(async () => ({ json: vi.fn(async () => ({})) }) as any)
    ;(globalThis as any).fetch = fetchMock

    const client = new DistributedCircuitBreakerClient('http://coord', 1000)
    const breaker = new CircuitBreaker('svc-r')
    client.register(breaker)
    await Promise.resolve() // registration call swallowed

    fetchMock.mockClear()

    client.startSync()
    vi.advanceTimersByTime(1000)
    await Promise.resolve()

    // One POST to /state for the registered breaker
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('http://coord/circuit-breakers/state')
    const init = fetchMock.mock.calls[0][1]
    const payload = JSON.parse(init.body as string)
    expect(payload.service).toBe('svc-r')
    expect(payload.node_id).toBe('node-2')
    expect(payload.state).toBe(CircuitState.CLOSED)
    expect(typeof payload.timestamp).toBe('number')
    expect(payload.health_info.name).toBe('svc-r')

    fetchMock.mockClear()
    client.stopSync()

    vi.advanceTimersByTime(3000)
    await Promise.resolve()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('getAggregatedState returns parsed JSON on success', async () => {
    const aggregate: any = {
      service: 'svc-s',
      consensusState: CircuitState.OPEN,
      totalNodes: 3,
      healthScore: 0.25,
      nodeStates: { a: CircuitState.OPEN },
    }

    const fetchMock = vi.fn(async () => ({ json: vi.fn(async () => aggregate) }) as any)
    ;(globalThis as any).fetch = fetchMock

    const client = new DistributedCircuitBreakerClient('http://coord')
    const result = await client.getAggregatedState('svc-s')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('http://coord/circuit-breakers/svc-s/aggregate')
    expect(result).toEqual(aggregate)
  })

  it('getAggregatedState returns default CLOSED aggregate on fetch error', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('network')
    })
    ;(globalThis as any).fetch = fetchMock

    const client = new DistributedCircuitBreakerClient('http://coord')
    const result = await client.getAggregatedState('svc-t')

    expect(result).toEqual({
      service: 'svc-t',
      consensusState: CircuitState.CLOSED,
      totalNodes: 0,
      healthScore: 0,
      nodeStates: {},
    })
  })

  it('reportState payload includes health_info and timestamp; errors are swallowed in sync loop', async () => {
    vi.stubEnv('NODE_ID', 'node-3')

    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/circuit-breakers/register')) return { json: vi.fn(async () => ({})) } as any
      if (url.endsWith('/circuit-breakers/state')) throw new Error('state post failed')
      return { json: vi.fn(async () => ({})) } as any
    })
    ;(globalThis as any).fetch = fetchMock

    const client = new DistributedCircuitBreakerClient('http://coord', 500)
    const breaker = new CircuitBreaker('svc-u')
    client.register(breaker)
    await Promise.resolve()

    client.startSync()
    vi.advanceTimersByTime(500)
    await Promise.resolve()

    // Should have attempted one /state post even though it fails; failure is swallowed
    const calls = fetchMock.mock.calls.map((c) => c[0])
    expect(calls).toContain('http://coord/circuit-breakers/register')
    expect(calls).toContain('http://coord/circuit-breakers/state')

    client.stopSync()
  })
})