import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals'
import {
  CircuitBreaker,
  CircuitBreakerOpenError,
  CircuitState,
  DistributedCircuitBreakerClient,
  withCircuitBreaker,
} from '../src/circuit-breaker'

const flushPromises = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

describe('CircuitBreaker', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2020-01-01T00:00:00.000Z'))
  })

  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
    jest.clearAllMocks()
  })

  it('starts in CLOSED state and allows requests', async () => {
    const breaker = new CircuitBreaker('svc-start')
    expect(breaker.getState()).toBe(CircuitState.CLOSED)

    const result = await breaker.execute(async () => 'ok')
    expect(result).toBe('ok')

    const health = breaker.getHealthInfo()
    expect(health.state).toBe(CircuitState.CLOSED)
    expect(health.metrics.totalCalls).toBe(1)
    expect(health.metrics.successfulCalls).toBe(1)
    expect(health.metrics.failedCalls).toBe(0)
    expect(health.metrics.rejectedCalls).toBe(0)
    expect(health.metrics.lastSuccessTime).toBeInstanceOf(Date)
  })

  it('records failures and throws the original error', async () => {
    const breaker = new CircuitBreaker('svc-fail-once')
    const err = new Error('boom')

    await expect(
      breaker.execute(async () => {
        throw err
      })
    ).rejects.toBe(err)

    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(1)
    expect(health.metrics.failedCalls).toBe(1)
    expect(health.metrics.successfulCalls).toBe(0)
    expect(health.metrics.lastFailureTime).toBeInstanceOf(Date)
  })

  it('opens when failureThreshold is reached and rejects subsequent calls with CircuitBreakerOpenError', async () => {
    const breaker = new CircuitBreaker('svc-open-threshold', {
      failureThreshold: 2,
      slidingWindowSize: 10,
      failureRateThreshold: 1, // prevent early open by failure rate
      timeoutMs: 30000,
    })

    await expect(breaker.execute(async () => Promise.reject(new Error('e1')))).rejects.toThrow('e1')
    await expect(breaker.execute(async () => Promise.reject(new Error('e2')))).rejects.toThrow('e2')

    expect(breaker.getState()).toBe(CircuitState.OPEN)

    await expect(breaker.execute(async () => 'never')).rejects.toBeInstanceOf(CircuitBreakerOpenError)

    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(2)
    expect(health.metrics.failedCalls).toBe(2)
    expect(health.metrics.rejectedCalls).toBe(1)
    expect(health.metrics.stateTransitions).toBe(1)
  })

  it('when open, uses fallback and increments rejectedCalls (async execute)', async () => {
    const breaker = new CircuitBreaker('svc-open-fallback', {
      failureThreshold: 1,
      failureRateThreshold: 1,
      timeoutMs: 30000,
    })

    await expect(breaker.execute(async () => Promise.reject(new Error('fail')))).rejects.toThrow('fail')
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    const value = await breaker.execute(async () => 'no', async () => 'fallback')
    expect(value).toBe('fallback')

    const health = breaker.getHealthInfo()
    expect(health.metrics.rejectedCalls).toBe(1)
    expect(health.metrics.totalCalls).toBe(1)
  })

  it('CircuitBreakerOpenError has correct name and remainingTimeMs is clamped to >= 0', async () => {
    const breaker = new CircuitBreaker('svc-open-remaining', {
      failureThreshold: 1,
      failureRateThreshold: 1,
      timeoutMs: 1000,
    })

    await expect(breaker.execute(async () => Promise.reject(new Error('fail')))).rejects.toThrow('fail')
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    jest.advanceTimersByTime(250)
    await expect(breaker.execute(async () => 'nope')).rejects.toEqual(
      expect.objectContaining({
        name: 'CircuitBreakerOpenError',
      })
    )

    try {
      await breaker.execute(async () => 'nope')
    } catch (e: any) {
      expect(e).toBeInstanceOf(CircuitBreakerOpenError)
      expect(typeof e.remainingTimeMs).toBe('number')
      expect(e.remainingTimeMs).toBeGreaterThanOrEqual(0)
    }

    jest.advanceTimersByTime(2000)
    await expect(breaker.execute(async () => 'nope')).resolves.toBe('nope')
  })

  it('transitions from OPEN to HALF_OPEN only after timeout, via getState()', async () => {
    const breaker = new CircuitBreaker('svc-half-open', {
      failureThreshold: 1,
      failureRateThreshold: 1,
      timeoutMs: 1000,
      halfOpenMaxCalls: 2,
      successThreshold: 2,
    })

    await expect(breaker.execute(async () => Promise.reject(new Error('fail')))).rejects.toThrow('fail')
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    jest.advanceTimersByTime(999)
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    jest.advanceTimersByTime(1)
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)

    const health = breaker.getHealthInfo()
    expect(health.metrics.stateTransitions).toBe(2) // CLOSED->OPEN, OPEN->HALF_OPEN
  })

  it('in HALF_OPEN, limits calls to halfOpenMaxCalls and rejects additional calls', async () => {
    const breaker = new CircuitBreaker('svc-half-open-max', {
      failureThreshold: 1,
      failureRateThreshold: 1,
      timeoutMs: 1000,
      halfOpenMaxCalls: 2,
      successThreshold: 10,
    })

    await expect(breaker.execute(async () => Promise.reject(new Error('fail')))).rejects.toThrow('fail')
    jest.advanceTimersByTime(1000)
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)

    const op = jest.fn(async () => 'ok')

    await expect(breaker.execute(op)).resolves.toBe('ok')
    await expect(breaker.execute(op)).resolves.toBe('ok')
    await expect(breaker.execute(op)).rejects.toBeInstanceOf(CircuitBreakerOpenError)

    const health = breaker.getHealthInfo()
    expect(health.state).toBe(CircuitState.HALF_OPEN)
    expect(health.metrics.rejectedCalls).toBe(1)
    expect(health.metrics.totalCalls).toBe(2) // only allowed calls increment totalCalls
  })

  it('in HALF_OPEN, a failure transitions immediately back to OPEN', async () => {
    const breaker = new CircuitBreaker('svc-half-open-fail', {
      failureThreshold: 1,
      failureRateThreshold: 1,
      timeoutMs: 1000,
      halfOpenMaxCalls: 3,
      successThreshold: 2,
    })

    await expect(breaker.execute(async () => Promise.reject(new Error('fail')))).rejects.toThrow('fail')
    jest.advanceTimersByTime(1000)
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)

    await expect(breaker.execute(async () => Promise.reject(new Error('half-open-fail')))).rejects.toThrow(
      'half-open-fail'
    )
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    const health = breaker.getHealthInfo()
    expect(health.metrics.stateTransitions).toBe(3) // CLOSED->OPEN, OPEN->HALF_OPEN, HALF_OPEN->OPEN
  })

  it('in HALF_OPEN, reaching successThreshold closes the circuit and resets counts', async () => {
    const breaker = new CircuitBreaker('svc-half-open-close', {
      failureThreshold: 1,
      failureRateThreshold: 1,
      timeoutMs: 1000,
      halfOpenMaxCalls: 3,
      successThreshold: 2,
    })

    await expect(breaker.execute(async () => Promise.reject(new Error('fail')))).rejects.toThrow('fail')
    jest.advanceTimersByTime(1000)
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)

    await expect(breaker.execute(async () => 's1')).resolves.toBe('s1')
    await expect(breaker.execute(async () => 's2')).resolves.toBe('s2')

    expect(breaker.getState()).toBe(CircuitState.CLOSED)

    const health = breaker.getHealthInfo()
    expect(health.failureCount).toBe(0)
    expect(health.successCount).toBe(0)
    expect(health.metrics.stateTransitions).toBe(3) // CLOSED->OPEN, OPEN->HALF_OPEN, HALF_OPEN->CLOSED
  })

  it('opens based on failureRateThreshold using sliding window (even if failureCount below threshold)', async () => {
    const breaker = new CircuitBreaker('svc-open-rate', {
      failureThreshold: 999,
      slidingWindowSize: 4,
      failureRateThreshold: 0.5,
      timeoutMs: 30000,
    })

    await breaker.execute(async () => 'ok1')
    await breaker.execute(async () => 'ok2')
    await expect(breaker.execute(async () => Promise.reject(new Error('f1')))).rejects.toThrow('f1')
    await expect(breaker.execute(async () => Promise.reject(new Error('f2')))).rejects.toThrow('f2')

    expect(breaker.getState()).toBe(CircuitState.OPEN)
    const health = breaker.getHealthInfo()
    expect(health.failureCount).toBe(2)
    expect(health.failureRate).toBe(0.5)
  })

  it('averageResponseTimeMs updates based on measured durations (async)', async () => {
    const breaker = new CircuitBreaker('svc-avg-async')

    const nowSpy = jest.spyOn(Date, 'now')
    nowSpy.mockReturnValueOnce(0).mockReturnValueOnce(10) // op1 duration 10
    await breaker.execute(async () => 'a')

    nowSpy.mockReturnValueOnce(100).mockReturnValueOnce(130) // op2 duration 30
    await breaker.execute(async () => 'b')

    const health = breaker.getHealthInfo()
    expect(health.metrics.averageResponseTimeMs).toBe(20)
  })

  it('averageResponseTimeMs updates based on measured durations (sync)', () => {
    const breaker = new CircuitBreaker('svc-avg-sync')

    const nowSpy = jest.spyOn(Date, 'now')
    nowSpy.mockReturnValueOnce(0).mockReturnValueOnce(25)
    const r1 = breaker.executeSync(() => 'x')
    expect(r1).toBe('x')

    nowSpy.mockReturnValueOnce(100).mockReturnValueOnce(105)
    const r2 = breaker.executeSync(() => 'y')
    expect(r2).toBe('y')

    const health = breaker.getHealthInfo()
    expect(health.metrics.averageResponseTimeMs).toBe(15)
  })

  it('executeSync uses fallback when open and increments rejectedCalls', () => {
    const breaker = new CircuitBreaker('svc-sync-fallback', {
      failureThreshold: 1,
      failureRateThreshold: 1,
      timeoutMs: 30000,
    })

    expect(() => breaker.executeSync(() => {
      throw new Error('fail')
    })).toThrow('fail')

    expect(breaker.getState()).toBe(CircuitState.OPEN)

    const v = breaker.executeSync(
      () => 'nope',
      () => 'fallback-sync'
    )
    expect(v).toBe('fallback-sync')

    const health = breaker.getHealthInfo()
    expect(health.metrics.rejectedCalls).toBe(1)
    expect(health.metrics.totalCalls).toBe(1)
  })

  it('getHealthInfo exposes partial config (failureThreshold/successThreshold/timeoutMs) only', () => {
    const breaker = new CircuitBreaker('svc-config', {
      failureThreshold: 7,
      successThreshold: 9,
      timeoutMs: 1234,
      halfOpenMaxCalls: 99,
      slidingWindowSize: 2,
      failureRateThreshold: 0.1,
    })

    const health = breaker.getHealthInfo()
    expect(health.config).toEqual({
      failureThreshold: 7,
      successThreshold: 9,
      timeoutMs: 1234,
    })
    expect((health.config as any).halfOpenMaxCalls).toBeUndefined()
    expect((health.config as any).slidingWindowSize).toBeUndefined()
    expect((health.config as any).failureRateThreshold).toBeUndefined()
  })
})

describe('CircuitBreaker registry', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2020-01-01T00:00:00.000Z'))
  })

  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
    jest.clearAllMocks()
  })

  it('getOrCreate returns the same instance for the same name', () => {
    const b1 = CircuitBreaker.getOrCreate('svc-registry', { failureThreshold: 1 })
    const b2 = CircuitBreaker.getOrCreate('svc-registry', { failureThreshold: 999 })
    expect(b1).toBe(b2)
  })

  it('getRegistry returns a copy of registry map (mutations do not affect internal map)', () => {
    const name = `svc-registry-copy-${Date.now()}`
    const breaker = CircuitBreaker.getOrCreate(name)

    const regCopy = CircuitBreaker.getRegistry()
    expect(regCopy.get(name)).toBe(breaker)

    regCopy.delete(name)
    const regCopy2 = CircuitBreaker.getRegistry()
    expect(regCopy2.has(name)).toBe(true)
  })
})

describe('withCircuitBreaker decorator', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2020-01-01T00:00:00.000Z'))
  })

  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
    jest.clearAllMocks()
  })

  it('wraps an async method so calls go through CircuitBreaker.execute', async () => {
    const executeSpy = jest.spyOn(CircuitBreaker.prototype as any, 'execute')

    class Svc {
      async work(x: number) {
        return x * 2
      }
    }

    const descriptor = Object.getOwnPropertyDescriptor(Svc.prototype, 'work')!
    const decoratedDescriptor = withCircuitBreaker('svc-decorated')(Svc.prototype, 'work', descriptor)
    Object.defineProperty(Svc.prototype, 'work', decoratedDescriptor)

    const s = new Svc()
    const out = await s.work(3)
    expect(out).toBe(6)

    expect(executeSpy).toHaveBeenCalledTimes(1)
    const [op] = executeSpy.mock.calls[0]
    expect(typeof op).toBe('function')
  })

  it('decorated method propagates underlying operation error (not CircuitBreakerOpenError when closed)', async () => {
    class Svc {
      async work() {
        throw new Error('service-fail')
      }
    }

    const descriptor = Object.getOwnPropertyDescriptor(Svc.prototype, 'work')!
    const decoratedDescriptor = withCircuitBreaker('svc-decorated-fail')(Svc.prototype, 'work', descriptor)
    Object.defineProperty(Svc.prototype, 'work', decoratedDescriptor)

    const s = new Svc()
    await expect(s.work()).rejects.toThrow('service-fail')
  })
})

describe('DistributedCircuitBreakerClient', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2020-01-01T00:00:00.000Z'))
    ;(globalThis as any).fetch = jest.fn()
    delete process.env.NODE_ID
  })

  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
    jest.clearAllMocks()
    delete (globalThis as any).fetch
    delete process.env.NODE_ID
  })

  it('register sends registration payload with derived node_id and thresholds', async () => {
    ;(globalThis as any).fetch = jest.fn().mockResolvedValue({
      json: async () => ({}),
    })

    const client = new DistributedCircuitBreakerClient('http://coordinator', 5000)
    const breaker = new CircuitBreaker('svc-dist', { failureThreshold: 11, successThreshold: 22 })

    client.register(breaker)
    await flushPromises()

    expect((globalThis as any).fetch).toHaveBeenCalledTimes(1)
    const [url, init] = (globalThis as any).fetch.mock.calls[0]
    expect(url).toBe('http://coordinator/circuit-breakers/register')
    expect(init.method).toBe('POST')
    const parsed = JSON.parse(init.body)
    expect(parsed.service).toBe('svc-dist')
    expect(typeof parsed.node_id).toBe('string')
    expect(parsed.node_id).toBe(`ts-${process.pid}`)
    expect(parsed.failure_threshold).toBe(11)
    expect(parsed.success_threshold).toBe(22)
  })

  it('register uses NODE_ID env var when present', async () => {
    process.env.NODE_ID = 'node-abc'
    ;(globalThis as any).fetch = jest.fn().mockResolvedValue({
      json: async () => ({}),
    })

    const client = new DistributedCircuitBreakerClient('http://coordinator', 5000)
    const breaker = new CircuitBreaker('svc-dist-env')

    client.register(breaker)
    await flushPromises()

    const [, init] = (globalThis as any).fetch.mock.calls[0]
    const parsed = JSON.parse(init.body)
    expect(parsed.node_id).toBe('node-abc')
  })

  it('startSync triggers periodic state reports for registered breakers', async () => {
    ;(globalThis as any).fetch = jest.fn().mockResolvedValue({
      json: async () => ({}),
    })

    const client = new DistributedCircuitBreakerClient('http://coordinator', 1000)
    const b1 = new CircuitBreaker('svc-a')
    const b2 = new CircuitBreaker('svc-b')
    client.register(b1)
    client.register(b2)
    await flushPromises()
    ;(globalThis as any).fetch.mockClear()

    client.startSync()
    jest.advanceTimersByTime(1000)
    await flushPromises()

    expect((globalThis as any).fetch).toHaveBeenCalledTimes(2)
    const urls = (globalThis as any).fetch.mock.calls.map((c: any[]) => c[0]).sort()
    expect(urls).toEqual([
      'http://coordinator/circuit-breakers/state',
      'http://coordinator/circuit-breakers/state',
    ])
  })

  it('stopSync stops further periodic reports', async () => {
    ;(globalThis as any).fetch = jest.fn().mockResolvedValue({
      json: async () => ({}),
    })

    const client = new DistributedCircuitBreakerClient('http://coordinator', 1000)
    client.register(new CircuitBreaker('svc-stop'))
    await flushPromises()
    ;(globalThis as any).fetch.mockClear()

    client.startSync()
    jest.advanceTimersByTime(1000)
    await flushPromises()
    expect((globalThis as any).fetch).toHaveBeenCalledTimes(1)

    client.stopSync()
    ;(globalThis as any).fetch.mockClear()

    jest.advanceTimersByTime(5000)
    await flushPromises()
    expect((globalThis as any).fetch).toHaveBeenCalledTimes(0)
  })

  it('getAggregatedState returns parsed JSON on success', async () => {
    const agg = {
      service: 'svc-x',
      consensusState: CircuitState.OPEN,
      totalNodes: 2,
      healthScore: 0.4,
      nodeStates: { a: CircuitState.OPEN, b: CircuitState.CLOSED },
    }
    ;(globalThis as any).fetch = jest.fn().mockResolvedValue({
      json: async () => agg,
    })

    const client = new DistributedCircuitBreakerClient('http://coordinator', 5000)
    await expect(client.getAggregatedState('svc-x')).resolves.toEqual(agg)

    expect((globalThis as any).fetch).toHaveBeenCalledWith(
      'http://coordinator/circuit-breakers/svc-x/aggregate'
    )
  })

  it('getAggregatedState returns default CLOSED aggregate on fetch error', async () => {
    ;(globalThis as any).fetch = jest.fn().mockRejectedValue(new Error('network'))

    const client = new DistributedCircuitBreakerClient('http://coordinator', 5000)
    const result = await client.getAggregatedState('svc-y')
    expect(result).toEqual({
      service: 'svc-y',
      consensusState: CircuitState.CLOSED,
      totalNodes: 0,
      healthScore: 0,
      nodeStates: {},
    })
  })

  it('startSync is idempotent (calling twice does not create a second interval)', async () => {
    ;(globalThis as any).fetch = jest.fn().mockResolvedValue({
      json: async () => ({}),
    })

    const setIntervalSpy = jest.spyOn(globalThis, 'setInterval')

    const client = new DistributedCircuitBreakerClient('http://coordinator', 1000)
    client.register(new CircuitBreaker('svc-idem'))
    await flushPromises()
    ;(globalThis as any).fetch.mockClear()

    client.startSync()
    client.startSync()
    expect(setIntervalSpy).toHaveBeenCalledTimes(1)
  })
})