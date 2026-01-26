import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals'
import { CircuitBreaker, CircuitBreakerOpenError, CircuitState, DistributedCircuitBreakerClient, withCircuitBreaker } from '../src/circuit-breaker'

let nameCounter = 0
const nextName = (prefix = 'svc') => `${prefix}-${nameCounter++}`

const createDeferred = <T = any>() => {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: any) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  ;(global as any).fetch = jest.fn()
})
afterEach(() => {
  jest.clearAllMocks()
  jest.useRealTimers()
  delete (process as any).env.NODE_ID
})

describe('CircuitBreakerOpenError', () => {
  it('sets correct name and message and remaining time', () => {
    const err = new CircuitBreakerOpenError('payments', 123.4)
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('CircuitBreakerOpenError')
    expect(err.message).toContain("Circuit breaker 'payments' is open")
    expect(err.message).toContain('123')
    // @ts-ignore - runtime property exists
    expect(err.remainingTimeMs).toBe(123.4)
  })
})

describe('CircuitBreaker basics', () => {
  it('starts closed and executes a successful operation updating metrics', async () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2024-01-01T00:00:00.000Z'))

    const breaker = new CircuitBreaker(nextName())
    const op = () => new Promise<string>(res => setTimeout(() => res('ok'), 50))

    const p = breaker.execute(op)
    jest.advanceTimersByTime(50)
    const result = await p

    expect(result).toBe('ok')
    const health = breaker.getHealthInfo()
    expect(health.state).toBe(CircuitState.CLOSED)
    expect(health.metrics.totalCalls).toBe(1)
    expect(health.metrics.successfulCalls).toBe(1)
    expect(health.metrics.averageResponseTimeMs).toBeGreaterThanOrEqual(49)
    expect(health.metrics.averageResponseTimeMs).toBeLessThanOrEqual(55)
    expect(health.metrics.lastSuccessTime).toBeInstanceOf(Date)
  })

  it('records a failure and increments failedCalls and failureCount', async () => {
    const breaker = new CircuitBreaker(nextName(), { failureThreshold: 10 })
    await expect(
      breaker.execute(() => Promise.reject(new Error('boom')))
    ).rejects.toThrow('boom')
    const health = breaker.getHealthInfo()
    expect(health.failureCount).toBe(1)
    expect(health.metrics.failedCalls).toBe(1)
    expect(health.metrics.lastFailureTime).toBeInstanceOf(Date)
    expect(health.state).toBe(CircuitState.CLOSED)
  })

  it('opens after reaching failureThreshold and rejects subsequent calls', () => {
    const breaker = new CircuitBreaker(nextName(), { failureThreshold: 2, timeoutMs: 1000 })
    expect(() => breaker.executeSync(() => { throw new Error('e1') })).toThrow('e1')
    expect(() => breaker.executeSync(() => { throw new Error('e2') })).toThrow('e2')
    expect(breaker.getState()).toBe(CircuitState.OPEN)
    expect(() => breaker.executeSync(() => 'ok')).toThrow(CircuitBreakerOpenError)
    const health = breaker.getHealthInfo()
    expect(health.metrics.rejectedCalls).toBe(1)
  })

  it('uses fallback when breaker is open and increments rejectedCalls', async () => {
    const breaker = new CircuitBreaker(nextName(), { failureThreshold: 1, timeoutMs: 1000 })
    expect(() => breaker.executeSync(() => { throw new Error('fail') })).toThrow('fail')
    expect(breaker.getState()).toBe(CircuitState.OPEN)
    const result = await breaker.execute(
      () => Promise.resolve('not-used'),
      () => Promise.resolve('fallback')
    )
    expect(result).toBe('fallback')
    expect(breaker.getHealthInfo().metrics.rejectedCalls).toBe(1)
  })

  it('opens due to failure rate threshold using sliding window', () => {
    const breaker = new CircuitBreaker(nextName(), { failureThreshold: 100, slidingWindowSize: 4, failureRateThreshold: 0.5 })
    expect(() => breaker.executeSync(() => { throw new Error('a') })).toThrow('a')
    expect(breaker.getState()).toBe(CircuitState.CLOSED)
    expect(() => breaker.executeSync(() => { throw new Error('b') })).toThrow('b')
    expect(breaker.getState()).toBe(CircuitState.CLOSED)
    expect(() => breaker.executeSync(() => { throw new Error('c') })).toThrow('c')
    expect(breaker.getState()).toBe(CircuitState.OPEN)
  })

  it('transitions OPEN -> HALF_OPEN after timeout and HALF_OPEN -> CLOSED after enough successes', () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2024-01-01T00:00:00.000Z'))
    const breaker = new CircuitBreaker(nextName(), {
      failureThreshold: 1,
      timeoutMs: 1000,
      successThreshold: 2,
      halfOpenMaxCalls: 10
    })
    expect(() => breaker.executeSync(() => { throw new Error('trip') })).toThrow('trip')
    expect(breaker.getState()).toBe(CircuitState.OPEN)
    // Before timeout
    expect(breaker.getState()).toBe(CircuitState.OPEN)
    jest.advanceTimersByTime(1000)
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)
    expect(breaker.executeSync(() => 's1')).toBe('s1')
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)
    expect(breaker.executeSync(() => 's2')).toBe('s2')
    expect(breaker.getState()).toBe(CircuitState.CLOSED)
    const transitions = breaker.getHealthInfo().metrics.stateTransitions
    expect(transitions).toBeGreaterThanOrEqual(3)
  })

  it('HALF_OPEN enforces halfOpenMaxCalls and rejects extra calls', async () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2024-01-01T00:00:00.000Z'))
    const breaker = new CircuitBreaker(nextName(), {
      failureThreshold: 1,
      timeoutMs: 1000,
      successThreshold: 5,
      halfOpenMaxCalls: 1
    })
    expect(() => breaker.executeSync(() => { throw new Error('trip') })).toThrow('trip')
    jest.advanceTimersByTime(1000)
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)

    const d = createDeferred<string>()
    const first = breaker.execute(() => d.promise)
    await expect(
      breaker.execute(() => Promise.resolve('should-not-run'))
    ).rejects.toBeInstanceOf(CircuitBreakerOpenError)
    expect(breaker.getHealthInfo().metrics.rejectedCalls).toBe(1)
    d.resolve('ok')
    await expect(first).resolves.toBe('ok')
  })

  it('HALF_OPEN failure transitions back to OPEN', () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2024-01-01T00:00:00.000Z'))
    const breaker = new CircuitBreaker(nextName(), {
      failureThreshold: 1,
      timeoutMs: 500,
      halfOpenMaxCalls: 3
    })
    expect(() => breaker.executeSync(() => { throw new Error('trip') })).toThrow()
    jest.advanceTimersByTime(500)
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)
    expect(() => breaker.executeSync(() => { throw new Error('fail-half') })).toThrow()
    expect(breaker.getState()).toBe(CircuitState.OPEN)
    expect(breaker.getHealthInfo().metrics.stateTransitions).toBeGreaterThanOrEqual(2)
  })

  it('executeSync returns result and updates metrics', () => {
    const breaker = new CircuitBreaker(nextName())
    const result = breaker.executeSync(() => 42)
    expect(result).toBe(42)
    const m = breaker.getHealthInfo().metrics
    expect(m.totalCalls).toBe(1)
    expect(m.successfulCalls).toBe(1)
  })

  it('averageResponseTimeMs computes average over multiple calls', async () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2024-01-01T00:00:00.000Z'))
    const breaker = new CircuitBreaker(nextName())
    const p1 = breaker.execute(() => new Promise(res => setTimeout(() => res('a'), 50)))
    jest.advanceTimersByTime(50)
    await p1
    const p2 = breaker.execute(() => new Promise(res => setTimeout(() => res('b'), 150)))
    jest.advanceTimersByTime(150)
    await p2
    const avg = breaker.getHealthInfo().metrics.averageResponseTimeMs
    expect(avg).toBeGreaterThanOrEqual(99)
    expect(avg).toBeLessThanOrEqual(151)
  })

  it('failureCount decreases with success while closed but not below zero', () => {
    const breaker = new CircuitBreaker(nextName(), { failureThreshold: 10 })
    try { breaker.executeSync(() => { throw new Error('x') }) } catch {}
    let health = breaker.getHealthInfo()
    expect(health.failureCount).toBe(1)
    breaker.executeSync(() => 'ok')
    health = breaker.getHealthInfo()
    expect(health.failureCount).toBe(0)
    breaker.executeSync(() => 'ok')
    expect(breaker.getHealthInfo().failureCount).toBe(0)
  })

  it('getOrCreate returns same instance and getRegistry returns a copy', () => {
    const nm = nextName('reg')
    const b1 = CircuitBreaker.getOrCreate(nm)
    const b2 = CircuitBreaker.getOrCreate(nm)
    expect(b1).toBe(b2)
    const nm2 = nextName('reg')
    CircuitBreaker.getOrCreate(nm2)
    const reg1 = CircuitBreaker.getRegistry()
    expect(reg1.size).toBeGreaterThanOrEqual(2)
    reg1.clear()
    const reg2 = CircuitBreaker.getRegistry()
    expect(reg2.size).toBeGreaterThanOrEqual(2)
  })

  it('getHealthInfo exposes expected fields and partial config', () => {
    const cfg = { failureThreshold: 7, successThreshold: 4, timeoutMs: 1234 }
    const breaker = new CircuitBreaker(nextName(), cfg)
    const info = breaker.getHealthInfo()
    expect(info.name).toBeDefined()
    expect(Object.values(CircuitState)).toContain(info.state)
    expect(info.metrics).toBeDefined()
    expect(info.config.failureThreshold).toBe(7)
    expect(info.config.successThreshold).toBe(4)
    expect(info.config.timeoutMs).toBe(1234)
  })
})

describe('DistributedCircuitBreakerClient', () => {
  it('register sends POST to coordinator with expected body', async () => {
    ;(process as any).env.NODE_ID = 'node-123'
    const fetchMock = (global as any).fetch as jest.Mock
    fetchMock.mockResolvedValue({ ok: true } as any)
    const client = new DistributedCircuitBreakerClient('http://coordinator.local')
    const breaker = new CircuitBreaker(nextName(), { failureThreshold: 9, successThreshold: 2 })
    client.register(breaker)
    await Promise.resolve()

    expect(fetchMock).toHaveBeenCalled()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://coordinator.local/circuit-breakers/register')
    const body = JSON.parse(init.body)
    expect(body.service).toBe(breaker.name)
    expect(body.node_id).toBe('node-123')
    expect(body.failure_threshold).toBe(breaker.getHealthInfo().config.failureThreshold)
    expect(body.success_threshold).toBe(breaker.getHealthInfo().config.successThreshold)
  })

  it('startSync triggers periodic state reports for registered breakers', async () => {
    jest.useFakeTimers()
    ;(process as any).env.NODE_ID = 'node-ABC'
    const fetchMock = (global as any).fetch as jest.Mock
    fetchMock.mockResolvedValue({ ok: true } as any)

    const client = new DistributedCircuitBreakerClient('http://coord', 2000)
    const b1 = new CircuitBreaker(nextName())
    const b2 = new CircuitBreaker(nextName())
    client.register(b1)
    client.register(b2)
    await Promise.resolve()

    client.startSync()
    expect(fetchMock).toHaveBeenCalledTimes(2) // two registrations
    jest.advanceTimersByTime(2000)

    const stateCalls = fetchMock.mock.calls.filter(c => c[0] === 'http://coord/circuit-breakers/state')
    expect(stateCalls.length).toBe(2)
    const bodies = stateCalls.map(c => JSON.parse(c[1].body))
    expect(bodies.map(b => b.service).sort()).toEqual([b1.name, b2.name].sort())
    for (const b of bodies) {
      expect(b.node_id).toBe('node-ABC')
      expect(Object.values(CircuitState)).toContain(b.state)
      expect(b.health_info.name).toBeDefined()
    }
  })

  it('stopSync stops further state reports', async () => {
    jest.useFakeTimers()
    const fetchMock = (global as any).fetch as jest.Mock
    fetchMock.mockResolvedValue({ ok: true } as any)
    const client = new DistributedCircuitBreakerClient('http://coord', 1000)
    const b = new CircuitBreaker(nextName())
    client.register(b)
    await Promise.resolve()
    client.startSync()
    jest.advanceTimersByTime(1000)
    const callsAfterFirstTick = fetchMock.mock.calls.length
    client.stopSync()
    jest.advanceTimersByTime(3000)
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirstTick)
  })

  it('getAggregatedState returns successful response JSON', async () => {
    const fetchMock = (global as any).fetch as jest.Mock
    const payload = {
      service: 'svc',
      consensusState: CircuitState.CLOSED,
      totalNodes: 3,
      healthScore: 0.9,
      nodeStates: { a: CircuitState.CLOSED, b: CircuitState.OPEN }
    }
    fetchMock.mockResolvedValue({
      json: () => Promise.resolve(payload)
    } as any)
    const client = new DistributedCircuitBreakerClient('http://coord')
    const res = await client.getAggregatedState('svc')
    expect(res).toEqual(payload)
  })

  it('getAggregatedState returns default on fetch error', async () => {
    const fetchMock = (global as any).fetch as jest.Mock
    fetchMock.mockRejectedValue(new Error('network'))
    const client = new DistributedCircuitBreakerClient('http://coord')
    const res = await client.getAggregatedState('payments')
    expect(res.service).toBe('payments')
    expect(res.consensusState).toBe(CircuitState.CLOSED)
    expect(res.totalNodes).toBe(0)
    expect(res.nodeStates).toEqual({})
  })
})

describe('withCircuitBreaker decorator', () => {
  it('wraps method to use circuit breaker and opens after failure threshold', async () => {
    const nm = nextName('decorator')
    class Service {
      async work(success: boolean) {
        if (!success) throw new Error('fail-op')
        return 'ok'
      }
    }
    const proto = Service.prototype
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'work')!
    const decorated = withCircuitBreaker(nm, { failureThreshold: 1, timeoutMs: 10000 })(proto, 'work', descriptor)
    Object.defineProperty(proto, 'work', decorated)

    const svc = new Service()
    await expect(svc.work(false)).rejects.toThrow('fail-op')

    await expect(svc.work(true)).rejects.toBeInstanceOf(CircuitBreakerOpenError)
  })
})