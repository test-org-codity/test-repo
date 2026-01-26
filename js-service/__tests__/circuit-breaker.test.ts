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

  it('starts CLOSED and allows requests', async () => {
    const breaker = new CircuitBreaker('svc')
    expect(breaker.getState()).toBe(CircuitState.CLOSED)

    const res = await breaker.execute(async () => 'ok')
    expect(res).toBe('ok')

    const health = breaker.getHealthInfo()
    expect(health.state).toBe(CircuitState.CLOSED)
    expect(health.metrics.totalCalls).toBe(1)
    expect(health.metrics.successfulCalls).toBe(1)
    expect(health.metrics.failedCalls).toBe(0)
    expect(health.metrics.rejectedCalls).toBe(0)
    expect(health.metrics.lastSuccessTime).toBeInstanceOf(Date)
    expect(health.metrics.lastFailureTime).toBe(null)
  })

  it('records a failure, rethrows the original error, and updates metrics/timestamps', async () => {
    const breaker = new CircuitBreaker('svc', { failureThreshold: 10, slidingWindowSize: 4 })
    const err = new Error('boom')

    await expect(
      breaker.execute(async () => {
        throw err
      })
    ).rejects.toBe(err)

    const health = breaker.getHealthInfo()
    expect(health.state).toBe(CircuitState.CLOSED)
    expect(health.failureCount).toBe(1)
    expect(health.metrics.totalCalls).toBe(1)
    expect(health.metrics.failedCalls).toBe(1)
    expect(health.metrics.successfulCalls).toBe(0)
    expect(health.metrics.lastFailureTime).toBeInstanceOf(Date)
    expect(health.metrics.lastSuccessTime).toBe(null)
  })

  it('opens when failureCount reaches failureThreshold (CLOSED -> OPEN)', async () => {
    const breaker = new CircuitBreaker('svc', {
      failureThreshold: 2,
      slidingWindowSize: 10,
      failureRateThreshold: 1, // avoid opening due to failure rate earlier
      timeoutMs: 30000,
    })

    await expect(
      breaker.execute(async () => {
        throw new Error('f1')
      })
    ).rejects.toBeInstanceOf(Error)
    expect(breaker.getState()).toBe(CircuitState.CLOSED)

    await expect(
      breaker.execute(async () => {
        throw new Error('f2')
      })
    ).rejects.toBeInstanceOf(Error)

    expect(breaker.getState()).toBe(CircuitState.OPEN)
    const health = breaker.getHealthInfo()
    expect(health.metrics.stateTransitions).toBe(1)
  })

  it('opens due to failureRateThreshold even if failureCount is below failureThreshold', async () => {
    const breaker = new CircuitBreaker('svc', {
      failureThreshold: 100,
      slidingWindowSize: 4,
      failureRateThreshold: 0.5,
    })

    await breaker.execute(async () => 's1')
    await breaker.execute(async () => 's2')
    await expect(
      breaker.execute(async () => {
        throw new Error('f1')
      })
    ).rejects.toBeInstanceOf(Error)
    expect(breaker.getState()).toBe(CircuitState.CLOSED)

    await expect(
      breaker.execute(async () => {
        throw new Error('f2')
      })
    ).rejects.toBeInstanceOf(Error)

    expect(breaker.getState()).toBe(CircuitState.OPEN)
    const health = breaker.getHealthInfo()
    expect(health.failureRate).toBeGreaterThanOrEqual(0.5)
    expect(health.metrics.stateTransitions).toBe(1)
  })

  it('when OPEN, execute rejects with CircuitBreakerOpenError and increments rejectedCalls', async () => {
    const breaker = new CircuitBreaker('svc', {
      failureThreshold: 1,
      failureRateThreshold: 1,
      slidingWindowSize: 2,
      timeoutMs: 1000,
    })

    await expect(
      breaker.execute(async () => {
        throw new Error('fail')
      })
    ).rejects.toBeInstanceOf(Error)
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    // immediately try again: should be rejected
    let thrown: any
    try {
      await breaker.execute(async () => 'never')
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(CircuitBreakerOpenError)
    expect((thrown as CircuitBreakerOpenError).name).toBe('CircuitBreakerOpenError')
    expect((thrown as CircuitBreakerOpenError).remainingTimeMs).toBeGreaterThanOrEqual(0)

    const health = breaker.getHealthInfo()
    expect(health.metrics.rejectedCalls).toBe(1)
    expect(health.metrics.totalCalls).toBe(1) // rejected does not increment totalCalls
  })

  it('when OPEN, execute returns fallback result (and does not throw), still counts rejectedCalls', async () => {
    const breaker = new CircuitBreaker('svc', {
      failureThreshold: 1,
      failureRateThreshold: 1,
      slidingWindowSize: 2,
      timeoutMs: 1000,
    })

    await expect(
      breaker.execute(async () => {
        throw new Error('fail')
      })
    ).rejects.toBeInstanceOf(Error)
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    const operation = vi.fn(async () => 'op')
    const fallback = vi.fn(async () => 'fb')

    const res = await breaker.execute(operation, fallback)
    expect(res).toBe('fb')
    expect(operation).not.toHaveBeenCalled()
    expect(fallback).toHaveBeenCalledTimes(1)

    const health = breaker.getHealthInfo()
    expect(health.metrics.rejectedCalls).toBe(1)
    expect(health.metrics.totalCalls).toBe(1)
  })

  it('transitions OPEN -> HALF_OPEN after timeout when getState is called', async () => {
    const breaker = new CircuitBreaker('svc', {
      failureThreshold: 1,
      failureRateThreshold: 1,
      slidingWindowSize: 2,
      timeoutMs: 1000,
    })

    await expect(
      breaker.execute(async () => {
        throw new Error('fail')
      })
    ).rejects.toBeInstanceOf(Error)
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    vi.advanceTimersByTime(999)
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    vi.advanceTimersByTime(1)
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)

    const health = breaker.getHealthInfo()
    expect(health.metrics.stateTransitions).toBe(2) // CLOSED->OPEN, OPEN->HALF_OPEN
  })

  it('in HALF_OPEN, allows up to halfOpenMaxCalls and then rejects further calls', async () => {
    const breaker = new CircuitBreaker('svc', {
      failureThreshold: 1,
      failureRateThreshold: 1,
      slidingWindowSize: 2,
      timeoutMs: 1000,
      halfOpenMaxCalls: 2,
      successThreshold: 10,
    })

    await expect(
      breaker.execute(async () => {
        throw new Error('fail')
      })
    ).rejects.toBeInstanceOf(Error)
    vi.advanceTimersByTime(1000)
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)

    await breaker.execute(async () => 'a')
    await breaker.execute(async () => 'b')

    const fallback = vi.fn(async () => 'fb')
    const operation = vi.fn(async () => 'c')
    const res = await breaker.execute(operation, fallback)
    expect(res).toBe('fb')
    expect(operation).not.toHaveBeenCalled()
    expect(fallback).toHaveBeenCalledTimes(1)

    const health = breaker.getHealthInfo()
    expect(health.metrics.rejectedCalls).toBe(1)
  })

  it('in HALF_OPEN, a failure immediately transitions back to OPEN', async () => {
    const breaker = new CircuitBreaker('svc', {
      failureThreshold: 1,
      failureRateThreshold: 1,
      slidingWindowSize: 2,
      timeoutMs: 1000,
      halfOpenMaxCalls: 3,
      successThreshold: 2,
    })

    await expect(
      breaker.execute(async () => {
        throw new Error('fail')
      })
    ).rejects.toBeInstanceOf(Error)
    vi.advanceTimersByTime(1000)
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)

    await expect(
      breaker.execute(async () => {
        throw new Error('fail again')
      })
    ).rejects.toBeInstanceOf(Error)

    expect(breaker.getState()).toBe(CircuitState.OPEN)
    const health = breaker.getHealthInfo()
    expect(health.metrics.stateTransitions).toBe(3) // CLOSED->OPEN, OPEN->HALF_OPEN, HALF_OPEN->OPEN
  })

  it('in HALF_OPEN, closes after successThreshold successes and resets failureCount/successCount/openedAt', async () => {
    const breaker = new CircuitBreaker('svc', {
      failureThreshold: 1,
      failureRateThreshold: 1,
      slidingWindowSize: 5,
      timeoutMs: 1000,
      halfOpenMaxCalls: 3,
      successThreshold: 2,
    })

    await expect(
      breaker.execute(async () => {
        throw new Error('fail')
      })
    ).rejects.toBeInstanceOf(Error)
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    vi.advanceTimersByTime(1000)
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)

    await breaker.execute(async () => 's1')
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)

    await breaker.execute(async () => 's2')
    expect(breaker.getState()).toBe(CircuitState.CLOSED)

    const health = breaker.getHealthInfo()
    expect(health.failureCount).toBe(0)
    expect(health.successCount).toBe(0)
    expect(health.metrics.stateTransitions).toBe(3)
  })

  it('in CLOSED, recordSuccess decrements failureCount but does not go below 0', async () => {
    const breaker = new CircuitBreaker('svc', { failureThreshold: 10, slidingWindowSize: 10 })

    await expect(
      breaker.execute(async () => {
        throw new Error('f')
      })
    ).rejects.toBeInstanceOf(Error)

    let health = breaker.getHealthInfo()
    expect(health.failureCount).toBe(1)

    await breaker.execute(async () => 'ok')
    health = breaker.getHealthInfo()
    expect(health.failureCount).toBe(0)

    await breaker.execute(async () => 'ok2')
    health = breaker.getHealthInfo()
    expect(health.failureCount).toBe(0)
  })

  it('tracks averageResponseTimeMs across calls using Date.now durations (async execute)', async () => {
    const breaker = new CircuitBreaker('svc')

    const nowSpy = vi.spyOn(Date, 'now')
    // Call 1: duration 50
    nowSpy.mockReturnValueOnce(0).mockReturnValueOnce(50)
    await breaker.execute(async () => 'a')
    expect(breaker.getHealthInfo().metrics.averageResponseTimeMs).toBe(50)

    // Call 2: duration 150
    nowSpy.mockReturnValueOnce(100).mockReturnValueOnce(250)
    await breaker.execute(async () => 'b')
    expect(breaker.getHealthInfo().metrics.averageResponseTimeMs).toBe(100)

    nowSpy.mockRestore()
  })

  it('executeSync behaves similarly: records success and failure, and can throw CircuitBreakerOpenError when OPEN', () => {
    const breaker = new CircuitBreaker('svc', {
      failureThreshold: 1,
      failureRateThreshold: 1,
      slidingWindowSize: 2,
      timeoutMs: 1000,
    })

    const nowSpy = vi.spyOn(Date, 'now')
    nowSpy.mockReturnValueOnce(0).mockReturnValueOnce(10)
    const ok = breaker.executeSync(() => 'ok')
    expect(ok).toBe('ok')

    nowSpy.mockReturnValueOnce(20).mockReturnValueOnce(30)
    expect(() =>
      breaker.executeSync(() => {
        throw new Error('fail')
      })
    ).toThrowError('fail')
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    nowSpy.mockReturnValueOnce(40) // remaining time calc uses Date.now() once
    expect(() => breaker.executeSync(() => 'no')).toThrow(CircuitBreakerOpenError)

    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(2) // rejected does not increment
    expect(health.metrics.rejectedCalls).toBe(1)

    nowSpy.mockRestore()
  })

  it('getOrCreate returns same instance for same name and preserves registry snapshot behavior', () => {
    const a1 = CircuitBreaker.getOrCreate('shared', { failureThreshold: 1 })
    const a2 = CircuitBreaker.getOrCreate('shared', { failureThreshold: 999 })
    expect(a1).toBe(a2)

    const reg1 = CircuitBreaker.getRegistry()
    expect(reg1.get('shared')).toBe(a1)

    // snapshot: mutating returned map should not affect internal registry
    reg1.delete('shared')
    const reg2 = CircuitBreaker.getRegistry()
    expect(reg2.has('shared')).toBe(true)
  })
})

describe('CircuitBreakerOpenError', () => {
  it('sets error.name to CircuitBreakerOpenError and includes remaining time in message', () => {
    const err = new CircuitBreakerOpenError('svcA', 12.34)
    expect(err.name).toBe('CircuitBreakerOpenError')
    expect(err.message).toContain("Circuit breaker 'svcA' is open.")
    expect(err.message).toContain('Retry after')
  })
})

describe('DistributedCircuitBreakerClient', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2020-01-01T00:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    delete (globalThis as any).fetch
    delete process.env.NODE_ID
  })

  it('register() stores breaker and attempts sendRegistration (POST to /register) with node_id', async () => {
    process.env.NODE_ID = 'node-1'
    const fetchMock = vi.fn(async () => ({ json: async () => ({}) })) as any
    ;(globalThis as any).fetch = fetchMock

    const client = new DistributedCircuitBreakerClient('http://coord', 5000)
    const breaker = new CircuitBreaker('svc', { failureThreshold: 7, successThreshold: 9 })
    client.register(breaker)

    // sendRegistration is fire-and-forget; flush microtasks
    await Promise.resolve()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://coord/circuit-breakers/register')
    expect(init.method).toBe('POST')
    const body = JSON.parse(init.body)
    expect(body.service).toBe('svc')
    expect(body.node_id).toBe('node-1')
    expect(body.failure_threshold).toBe(7)
    expect(body.success_threshold).toBe(9)
  })

  it('startSync() sets an interval and periodically POSTs state for each registered breaker; stopSync() stops further posts', async () => {
    process.env.NODE_ID = 'node-xyz'
    const fetchMock = vi.fn(async () => ({ json: async () => ({}) })) as any
    ;(globalThis as any).fetch = fetchMock

    const client = new DistributedCircuitBreakerClient('http://coord', 100)
    const breaker = new CircuitBreaker('svc', { failureThreshold: 100 })
    client.register(breaker)
    await Promise.resolve() // registration fire-and-forget

    fetchMock.mockClear()

    client.startSync()
    vi.advanceTimersByTime(350)
    await Promise.resolve()

    const stateCalls = fetchMock.mock.calls.filter(
      ([url]: any[]) => url === 'http://coord/circuit-breakers/state'
    )
    expect(stateCalls.length).toBeGreaterThanOrEqual(3)

    const body = JSON.parse(stateCalls[0][1].body)
    expect(body.service).toBe('svc')
    expect(body.node_id).toBe('node-xyz')
    expect(body.state).toBe(CircuitState.CLOSED)
    expect(typeof body.timestamp).toBe('number')
    expect(body.health_info.name).toBe('svc')

    fetchMock.mockClear()
    client.stopSync()
    vi.advanceTimersByTime(300)
    await Promise.resolve()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('startSync() is idempotent (does not create multiple intervals)', async () => {
    const fetchMock = vi.fn(async () => ({ json: async () => ({}) })) as any
    ;(globalThis as any).fetch = fetchMock

    const client = new DistributedCircuitBreakerClient('http://coord', 50)
    const breaker = new CircuitBreaker('svc')
    client.register(breaker)
    await Promise.resolve()
    fetchMock.mockClear()

    client.startSync()
    client.startSync()

    vi.advanceTimersByTime(200)
    await Promise.resolve()

    const stateCalls = fetchMock.mock.calls.filter(
      ([url]: any[]) => url === 'http://coord/circuit-breakers/state'
    )
    // If multiple intervals were created, we'd see roughly double the calls.
    expect(stateCalls.length).toBeGreaterThanOrEqual(3)
    expect(stateCalls.length).toBeLessThanOrEqual(6)

    client.stopSync()
  })

  it('getAggregatedState returns parsed JSON when fetch succeeds', async () => {
    const agg = {
      service: 'svc',
      consensusState: CircuitState.OPEN,
      totalNodes: 2,
      healthScore: 0.2,
      nodeStates: { a: CircuitState.OPEN, b: CircuitState.CLOSED },
    }

    const fetchMock = vi.fn(async () => ({ json: async () => agg })) as any
    ;(globalThis as any).fetch = fetchMock

    const client = new DistributedCircuitBreakerClient('http://coord')
    const res = await client.getAggregatedState('svc')
    expect(res).toEqual(agg)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('http://coord/circuit-breakers/svc/aggregate')
  })

  it('getAggregatedState returns default CLOSED aggregate on fetch error', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('network')
    }) as any
    ;(globalThis as any).fetch = fetchMock

    const client = new DistributedCircuitBreakerClient('http://coord')
    const res = await client.getAggregatedState('svcX')
    expect(res).toEqual({
      service: 'svcX',
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

  it('wraps the method so calls go through CircuitBreaker.execute()', async () => {
    const executeSpy = vi.spyOn(CircuitBreaker.prototype, 'execute')

    class Demo {
      async work(x: number) {
        return x + 1
      }
    }

    const desc = Object.getOwnPropertyDescriptor(Demo.prototype, 'work')!
    const decorated = withCircuitBreaker('decor-svc')(Demo.prototype, 'work', desc)
    Object.defineProperty(Demo.prototype, 'work', decorated)

    const inst = new Demo()
    const res = await inst.work(41)
    expect(res).toBe(42)

    expect(executeSpy).toHaveBeenCalledTimes(1)
    const [operation] = executeSpy.mock.calls[0]
    expect(typeof operation).toBe('function')
  })

  it('uses CircuitBreaker.getOrCreate so multiple decorations with same name share breaker behavior (OPEN rejects)', async () => {
    class DemoA {
      async work() {
        return 'A'
      }
    }
    class DemoB {
      async work() {
        return 'B'
      }
    }

    const descA = Object.getOwnPropertyDescriptor(DemoA.prototype, 'work')!
    Object.defineProperty(
      DemoA.prototype,
      'work',
      withCircuitBreaker('shared-decor', {
        failureThreshold: 1,
        failureRateThreshold: 1,
        slidingWindowSize: 2,
        timeoutMs: 10000,
      })(DemoA.prototype, 'work', descA)
    )

    const descB = Object.getOwnPropertyDescriptor(DemoB.prototype, 'work')!
    Object.defineProperty(
      DemoB.prototype,
      'work',
      withCircuitBreaker('shared-decor')(DemoB.prototype, 'work', descB)
    )

    // Force the shared breaker to OPEN
    const breaker = CircuitBreaker.getOrCreate('shared-decor')
    await expect(
      breaker.execute(async () => {
        throw new Error('fail')
      })
    ).rejects.toBeInstanceOf(Error)
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    const a = new DemoA()
    const b = new DemoB()

    await expect(a.work()).rejects.toBeInstanceOf(CircuitBreakerOpenError)
    await expect(b.work()).rejects.toBeInstanceOf(CircuitBreakerOpenError)

    const health = breaker.getHealthInfo()
    expect(health.metrics.rejectedCalls).toBeGreaterThanOrEqual(2)
  })
})