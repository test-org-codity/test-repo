import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals'
import {
  CircuitBreaker,
  CircuitState,
  CircuitBreakerOpenError,
  DistributedCircuitBreakerClient,
  withCircuitBreaker
} from '../src/circuit-breaker'

describe('CircuitBreakerOpenError', () => {
  afterEach(() => {
    jest.restoreAllMocks()
    jest.clearAllMocks()
  })

  it('has correct message, name, and remainingTimeMs', () => {
    const err = new CircuitBreakerOpenError('svc', 1234)
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('CircuitBreakerOpenError')
    expect(err.message).toContain("Circuit breaker 'svc' is open. Retry after 1234ms")
    expect(err.remainingTimeMs).toBe(1234)
  })
})

describe('CircuitBreaker - registry', () => {
  afterEach(() => {
    jest.restoreAllMocks()
    jest.clearAllMocks()
  })

  it('getOrCreate returns same instance for same name', () => {
    const a = CircuitBreaker.getOrCreate('reg-1')
    const b = CircuitBreaker.getOrCreate('reg-1')
    expect(a).toBe(b)
  })

  it('getRegistry returns a copy of internal map', () => {
    const name = 'reg-2'
    const br = CircuitBreaker.getOrCreate(name)
    const copy = CircuitBreaker.getRegistry()
    expect(copy.get(name)).toBe(br)
    copy.set('new', CircuitBreaker.getOrCreate('new'))
    // internal registry should not include 'new'
    const internalAgain = CircuitBreaker.getRegistry()
    expect(internalAgain.has('new')).toBe(false)
  })
})

describe('CircuitBreaker - execute and metrics', () => {
  let now = 0
  beforeEach(() => {
    now = 0
    jest.spyOn(Date, 'now').mockImplementation(() => now)
  })
  afterEach(() => {
    jest.restoreAllMocks()
    jest.clearAllMocks()
  })

  it('records successful execution and updates metrics including averageResponseTimeMs', async () => {
    const name = 'exec-success'
    const breaker = new CircuitBreaker(name)
    now = 1000
    const op = async () => {
      now += 100 // simulate operation duration
      return 'ok'
    }
    const res = await breaker.execute(op)
    expect(res).toBe('ok')

    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(1)
    expect(health.metrics.successfulCalls).toBe(1)
    expect(health.metrics.failedCalls).toBe(0)
    expect(health.metrics.averageResponseTimeMs).toBe(100)
    expect(health.metrics.lastSuccessTime).toBeInstanceOf(Date)
    expect(breaker.getState()).toBe(CircuitState.CLOSED)
  })

  it('records failure and opens after reaching failureThreshold', async () => {
    const name = 'exec-fail-open'
    const breaker = new CircuitBreaker(name, { failureThreshold: 2, timeoutMs: 50, failureRateThreshold: 1 })
    // first failure
    now = 10
    await expect(breaker.execute(async () => {
      now += 10
      throw new Error('fail-1')
    })).rejects.toThrow('fail-1')
    expect(breaker.getState()).toBe(CircuitState.CLOSED)
    let health = breaker.getHealthInfo()
    expect(health.metrics.failedCalls).toBe(1)

    // second failure triggers OPEN
    await expect(breaker.execute(async () => {
      now += 10
      throw new Error('fail-2')
    })).rejects.toThrow('fail-2')
    expect(breaker.getState()).toBe(CircuitState.OPEN)
    health = breaker.getHealthInfo()
    expect(health.metrics.failedCalls).toBe(2)
    expect(health.metrics.lastFailureTime).toBeInstanceOf(Date)
  })

  it('when open: execute uses fallback and increments rejectedCalls without incrementing totalCalls', async () => {
    const name = 'open-fallback'
    const breaker = new CircuitBreaker(name, { failureThreshold: 1, timeoutMs: 1000 })
    now = 0
    // cause open
    await expect(breaker.execute(async () => {
      now += 5
      throw new Error('boom')
    })).rejects.toThrow('boom')
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    const before = breaker.getHealthInfo().metrics
    const res = await breaker.execute(async () => 'should not run', async () => 'fallback-value')
    const after = breaker.getHealthInfo().metrics

    expect(res).toBe('fallback-value')
    expect(after.rejectedCalls).toBe(before.rejectedCalls + 1)
    // totalCalls was not incremented because request was not allowed
    expect(after.totalCalls).toBe(before.totalCalls)
  })

  it('when open: execute throws CircuitBreakerOpenError with remaining time when no fallback', async () => {
    const name = 'open-throw'
    const breaker = new CircuitBreaker(name, { failureThreshold: 1, timeoutMs: 200 })
    now = 100
    // cause open at now=110 after failure (openedAt recorded at failure end)
    await expect(breaker.execute(async () => {
      now += 10
      throw new Error('fail!')
    })).rejects.toThrow('fail!')
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    // now unchanged, so remaining ~ 200ms
    await expect(breaker.execute(async () => 'x')).rejects.toThrow(CircuitBreakerOpenError)
    await breaker.execute(async () => 'x').catch((err) => {
      expect(err).toBeInstanceOf(CircuitBreakerOpenError)
      const e = err as CircuitBreakerOpenError
      expect(e.message).toContain(`Circuit breaker '${name}' is open. Retry after 200ms`)
      expect(e.remainingTimeMs).toBeGreaterThanOrEqual(0)
    })
  })
})

describe('CircuitBreaker - state transitions and HALF_OPEN behavior', () => {
  let now = 0
  beforeEach(() => {
    now = 0
    jest.spyOn(Date, 'now').mockImplementation(() => now)
  })
  afterEach(() => {
    jest.restoreAllMocks()
    jest.clearAllMocks()
  })

  it('transitions OPEN -> HALF_OPEN after timeout', async () => {
    const name = 'halfopen-timeout'
    const breaker = new CircuitBreaker(name, { failureThreshold: 1, timeoutMs: 50 })
    now = 0
    // cause open at now=10
    await expect(breaker.execute(async () => {
      now += 10
      throw new Error('to-open')
    })).rejects.toThrow('to-open')
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    // move time to just before timeout, still OPEN
    now = 59
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    // time at 60 >= openedAt(10)+50 => HALF_OPEN
    now = 60
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)
  })

  it('HALF_OPEN allows limited calls and then rejects further calls', async () => {
    const name = 'halfopen-limit'
    const breaker = new CircuitBreaker(name, { failureThreshold: 1, timeoutMs: 50, halfOpenMaxCalls: 2, successThreshold: 99 })
    now = 0
    // open circuit
    await expect(breaker.execute(async () => { now += 5; throw new Error('open') })).rejects.toThrow('open')
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    // move to HALF_OPEN
    now = 51
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)

    // two allowed calls succeed
    const op = async () => { now += 1; return 'ok' }
    await expect(breaker.execute(op)).resolves.toBe('ok')
    await expect(breaker.execute(op)).resolves.toBe('ok')

    // third call should be rejected with CircuitBreakerOpenError (no fallback)
    await expect(breaker.execute(op)).rejects.toBeInstanceOf(CircuitBreakerOpenError)
    const metrics = breaker.getHealthInfo().metrics
    expect(metrics.rejectedCalls).toBeGreaterThanOrEqual(1)
  })

  it('HALF_OPEN closes after reaching successThreshold', async () => {
    const name = 'halfopen-close'
    const breaker = new CircuitBreaker(name, { failureThreshold: 1, timeoutMs: 10, halfOpenMaxCalls: 5, successThreshold: 2 })
    now = 0
    await expect(breaker.execute(async () => { now += 1; throw new Error('fail') })).rejects.toThrow('fail')
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    now = 11
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)

    const op = async () => { now += 1; return 'ok' }
    await breaker.execute(op)
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)
    await breaker.execute(op)
    expect(breaker.getState()).toBe(CircuitState.CLOSED)
  })

  it('HALF_OPEN failure re-opens circuit immediately', async () => {
    const name = 'halfopen-fail-open'
    const breaker = new CircuitBreaker(name, { failureThreshold: 1, timeoutMs: 10, halfOpenMaxCalls: 3, successThreshold: 2 })
    now = 0
    await expect(breaker.execute(async () => { now += 2; throw new Error('f') })).rejects.toThrow('f')
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    now = 15
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)

    await expect(breaker.execute(async () => { now += 1; throw new Error('fail-half') })).rejects.toThrow('fail-half')
    expect(breaker.getState()).toBe(CircuitState.OPEN)
  })
})

describe('CircuitBreaker - sliding window failure rate threshold', () => {
  let now = 0
  beforeEach(() => {
    now = 0
    jest.spyOn(Date, 'now').mockImplementation(() => now)
  })
  afterEach(() => {
    jest.restoreAllMocks()
    jest.clearAllMocks()
  })

  it('opens when failure rate in sliding window exceeds threshold', async () => {
    const name = 'window-open'
    const breaker = new CircuitBreaker(name, {
      failureThreshold: 99, // ensure count threshold not hit
      slidingWindowSize: 4,
      failureRateThreshold: 0.5,
      timeoutMs: 1000
    })

    // first failure: failureRate = 1/4 = 0.25 < 0.5
    now = 0
    await expect(breaker.execute(async () => { now += 1; throw new Error('f1') })).rejects.toThrow('f1')
    expect(breaker.getState()).toBe(CircuitState.CLOSED)

    // second failure: failureRate = 2/4 = 0.5 -> opens
    await expect(breaker.execute(async () => { now += 1; throw new Error('f2') })).rejects.toThrow('f2')
    expect(breaker.getState()).toBe(CircuitState.OPEN)
  })
})

describe('CircuitBreaker - executeSync', () => {
  let now = 0
  beforeEach(() => {
    now = 0
    jest.spyOn(Date, 'now').mockImplementation(() => now)
  })
  afterEach(() => {
    jest.restoreAllMocks()
    jest.clearAllMocks()
  })

  it('executes sync operation successfully and updates metrics', () => {
    const name = 'sync-success'
    const breaker = new CircuitBreaker(name)
    now = 100
    const res = breaker.executeSync(() => {
      now += 25
      return 42
    })
    expect(res).toBe(42)
    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(1)
    expect(health.metrics.successfulCalls).toBe(1)
    expect(health.metrics.averageResponseTimeMs).toBe(25)
  })

  it('when open: executeSync returns fallback and increments rejectedCalls', () => {
    const name = 'sync-open-fallback'
    const breaker = new CircuitBreaker(name, { failureThreshold: 1, timeoutMs: 500 })
    now = 0
    expect(() => breaker.executeSync(() => {
      now += 10
      throw new Error('bad')
    })).toThrow('bad')
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    const before = breaker.getHealthInfo().metrics
    const out = breaker.executeSync(() => 1, () => 99)
    const after = breaker.getHealthInfo().metrics
    expect(out).toBe(99)
    expect(after.rejectedCalls).toBe(before.rejectedCalls + 1)
    expect(after.totalCalls).toBe(before.totalCalls)
  })
})

describe('CircuitBreaker - health info and metrics details', () => {
  let now = 0
  beforeEach(() => {
    now = 0
    jest.spyOn(Date, 'now').mockImplementation(() => now)
  })
  afterEach(() => {
    jest.restoreAllMocks()
    jest.clearAllMocks()
  })

  it('reports minimal config subset and metrics snapshot', async () => {
    const name = 'health-info'
    const breaker = new CircuitBreaker(name, {
      failureThreshold: 7,
      successThreshold: 4,
      timeoutMs: 3210
    })
    now = 1000
    await breaker.execute(async () => { now += 10; return 'ok' })
    const info = breaker.getHealthInfo()
    expect(info.name).toBe(name)
    expect(info.state).toBe(CircuitState.CLOSED)
    expect(info.metrics.totalCalls).toBe(1)
    expect(info.metrics.averageResponseTimeMs).toBe(10)
    // config should only include subset fields
    expect(info.config.failureThreshold).toBe(7)
    expect(info.config.successThreshold).toBe(4)
    expect(info.config.timeoutMs).toBe(3210)
    // ensure not all fields are present (Partial)
    expect(Object.keys(info.config)).toEqual(['failureThreshold', 'successThreshold', 'timeoutMs'])
  })

  it('keeps only last 100 response times for averaging', async () => {
    const name = 'avg-cap'
    const breaker = new CircuitBreaker(name)
    now = 0
    // push durations 1..110
    for (let i = 1; i <= 110; i++) {
      await breaker.execute(async () => { now += i; return i })
    }
    const avg = breaker.getHealthInfo().metrics.averageResponseTimeMs
    // average of 11..110 = (11 + 110) / 2 = 60.5
    expect(avg).toBeCloseTo(60.5, 5)
  })

  it('rejected calls do not increment totalCalls', async () => {
    const name = 'reject-nototal'
    const breaker = new CircuitBreaker(name, { failureThreshold: 1, timeoutMs: 1000 })
    now = 0
    // cause open
    await expect(breaker.execute(async () => { now += 1; throw new Error('fail') })).rejects.toThrow('fail')
    const before = breaker.getHealthInfo().metrics.totalCalls
    await breaker.execute(async () => 'x', async () => 'fallback')
    const after = breaker.getHealthInfo().metrics.totalCalls
    expect(after).toBe(before)
  })
})

describe('DistributedCircuitBreakerClient', () => {
  let fetchMock: jest.Mock
  beforeEach(() => {
    fetchMock = jest.fn()
    ;(global as any).fetch = fetchMock
  })
  afterEach(() => {
    jest.clearAllMocks()
    jest.restoreAllMocks()
    jest.useRealTimers()
  })

  it('register sends registration to coordinator with correct payload', async () => {
    process.env.NODE_ID = 'node-1'
    const client = new DistributedCircuitBreakerClient('http://coordinator')
    const breaker = new CircuitBreaker('svc-reg', { failureThreshold: 9, successThreshold: 2 })
    fetchMock.mockResolvedValue({ json: async () => ({ ok: true }) })
    client.register(breaker)
    // wait microtask tick for async fire-and-forget
    await Promise.resolve()
    expect(fetchMock).toHaveBeenCalled()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://coordinator/circuit-breakers/register')
    const body = JSON.parse((init as any).body)
    expect(body.service).toBe('svc-reg')
    expect(body.node_id).toBe('node-1')
    expect(body.failure_threshold).toBe(9)
    expect(body.success_threshold).toBe(2)
    expect((init as any).method).toBe('POST')
    expect((init as any).headers['Content-Type']).toBe('application/json')
  })

  it('startSync schedules periodic state reports and stopSync cancels them', async () => {
    jest.useFakeTimers()
    process.env.NODE_ID = 'node-2'
    const client = new DistributedCircuitBreakerClient('http://coordinator', 100)
    const breaker = new CircuitBreaker('svc-sync')
    fetchMock.mockResolvedValue({ json: async () => ({ ok: true }) })

    client.register(breaker)
    await Promise.resolve()
    fetchMock.mockClear()

    client.startSync()
    jest.advanceTimersByTime(350)
    // Should have reported roughly 3-4 times depending on timer ticks
    expect(fetchMock).toHaveBeenCalled()
    const callsDuringSync = fetchMock.mock.calls.length

    client.stopSync()
    fetchMock.mockClear()
    jest.advanceTimersByTime(500)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(callsDuringSync).toBeGreaterThan(0)
  })

  it('getAggregatedState returns aggregated data on success', async () => {
    const agg = {
      service: 'svc-agg',
      consensusState: CircuitState.CLOSED,
      totalNodes: 3,
      healthScore: 0.9,
      nodeStates: { a: CircuitState.CLOSED, b: CircuitState.OPEN }
    }
    fetchMock.mockResolvedValue({ json: async () => agg })
    const client = new DistributedCircuitBreakerClient('http://coordinator')
    const resp = await client.getAggregatedState('svc-agg')
    expect(resp).toEqual(agg)
    expect(fetchMock).toHaveBeenCalledWith('http://coordinator/circuit-breakers/svc-agg/aggregate')
  })

  it('getAggregatedState returns default on fetch failure', async () => {
    fetchMock.mockRejectedValue(new Error('network'))
    const client = new DistributedCircuitBreakerClient('http://coordinator')
    const resp = await client.getAggregatedState('svc-default')
    expect(resp.service).toBe('svc-default')
    expect(resp.consensusState).toBe(CircuitState.CLOSED)
    expect(resp.totalNodes).toBe(0)
    expect(resp.healthScore).toBe(0)
    expect(resp.nodeStates).toEqual({})
  })
})

describe('withCircuitBreaker decorator', () => {
  afterEach(() => {
    jest.restoreAllMocks()
    jest.clearAllMocks()
  })

  it('wraps method to execute via CircuitBreaker', async () => {
    const name = 'decorated-service'
    const decorator = withCircuitBreaker(name)

    class Service {
      async work(x: number) {
        return x + 1
      }
    }

    const proto = Service.prototype
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'work')!
    const newDescriptor = decorator(proto, 'work', descriptor) || descriptor
    Object.defineProperty(proto, 'work', newDescriptor)

    const breaker = CircuitBreaker.getOrCreate(name)
    const executeSpy = jest.spyOn(breaker, 'execute')
    executeSpy.mockImplementation(async (op: any) => op())

    const s = new Service()
    const out = await (s as any).work(41)
    expect(out).toBe(42)
    expect(executeSpy).toHaveBeenCalled()
  })
})