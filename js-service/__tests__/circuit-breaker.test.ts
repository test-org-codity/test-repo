import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals'
import {
  CircuitBreaker,
  CircuitBreakerOpenError,
  CircuitState,
  DistributedCircuitBreakerClient,
  withCircuitBreaker,
} from '../src/circuit-breaker'

describe('CircuitBreakerOpenError', () => {
  afterEach(() => {
    jest.clearAllMocks()
  })

  it('sets message with service name and rounded remaining time, and name property is CircuitBreakerOpenError', () => {
    const err = new CircuitBreakerOpenError('svc-A', 599.8)
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('CircuitBreakerOpenError')
    expect(err.message).toContain("Circuit breaker 'svc-A' is open")
    expect(err.message).toContain('600ms')
    expect((err as any).remainingTimeMs).toBe(599.8)
  })
})

describe('CircuitBreaker - core behavior', () => {
  beforeEach(() => {
    ;(global as any).fetch = jest.fn().mockResolvedValue({
      json: async () => ({}),
    })
  })

  afterEach(() => {
    jest.clearAllMocks()
    jest.useRealTimers()
  })

  it('success path updates metrics and average response time', async () => {
    jest.useFakeTimers()
    const name = `cb-success-${Math.random()}`
    const cb = new CircuitBreaker(name, { slidingWindowSize: 5 })

    const op = (ms: number, res: string) =>
      new Promise<string>((resolve) => setTimeout(() => resolve(res), ms))

    const p1 = cb.execute(() => op(20, 'ok1'))
    jest.advanceTimersByTime(20)
    await expect(p1).resolves.toBe('ok1')

    const p2 = cb.execute(() => op(40, 'ok2'))
    jest.advanceTimersByTime(40)
    await expect(p2).resolves.toBe('ok2')

    const health = cb.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(2)
    expect(health.metrics.successfulCalls).toBe(2)
    expect(health.metrics.failedCalls).toBe(0)
    expect(health.metrics.averageResponseTimeMs).toBeCloseTo(30, 2)
    expect(health.metrics.lastSuccessTime).not.toBeNull()
    expect(health.failureRate).toBeGreaterThanOrEqual(0)
  })

  it('failure threshold transitions to OPEN', async () => {
    jest.useFakeTimers()
    const name = `cb-failure-threshold-${Math.random()}`
    const cb = new CircuitBreaker(name, {
      failureThreshold: 2,
      failureRateThreshold: 1, // disable rate effect
    })

    const failingOp = () =>
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('boom')), 1))

    const p1 = cb.execute(failingOp)
    jest.advanceTimersByTime(1)
    await expect(p1).rejects.toThrow('boom')

    const p2 = cb.execute(failingOp)
    jest.advanceTimersByTime(1)
    await expect(p2).rejects.toThrow('boom')

    expect(cb.getState()).toBe(CircuitState.OPEN)
    const health = cb.getHealthInfo()
    expect(health.metrics.stateTransitions).toBe(1)
    expect(health.failureCount).toBeGreaterThanOrEqual(2)
  })

  it('failure rate threshold transitions to OPEN using sliding window', async () => {
    jest.useFakeTimers()
    const name = `cb-failure-rate-${Math.random()}`
    const cb = new CircuitBreaker(name, {
      slidingWindowSize: 4,
      failureThreshold: 100, // avoid threshold
      failureRateThreshold: 0.5,
    })

    const failingOp = () =>
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('fail')), 1))

    const p1 = cb.execute(failingOp)
    jest.advanceTimersByTime(1)
    await expect(p1).rejects.toThrow('fail')

    const p2 = cb.execute(failingOp)
    jest.advanceTimersByTime(1)
    await expect(p2).rejects.toThrow('fail')

    const p3 = cb.execute(failingOp)
    jest.advanceTimersByTime(1)
    await expect(p3).rejects.toThrow('fail')

    expect(cb.getState()).toBe(CircuitState.OPEN)
  })

  it('OPEN rejects and uses fallback without increasing totalCalls', async () => {
    jest.useFakeTimers()
    const name = `cb-open-fallback-${Math.random()}`
    const cb = new CircuitBreaker(name, {
      failureThreshold: 1,
    })

    const failingOp = () =>
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('nope')), 1))

    const p1 = cb.execute(failingOp)
    jest.advanceTimersByTime(1)
    await expect(p1).rejects.toThrow('nope')
    expect(cb.getState()).toBe(CircuitState.OPEN)

    const res = await cb.execute(
      () => Promise.resolve('should not run'),
      () => Promise.resolve('fallback')
    )
    expect(res).toBe('fallback')

    const health = cb.getHealthInfo()
    expect(health.metrics.rejectedCalls).toBe(1)
    expect(health.metrics.totalCalls).toBe(1)
  })

  it('OPEN throws CircuitBreakerOpenError with remaining time calculation', async () => {
    jest.useFakeTimers()
    jest.setSystemTime(0)
    const name = `cb-open-remaining-${Math.random()}`
    const cb = new CircuitBreaker(name, {
      timeoutMs: 1000,
      failureThreshold: 1,
    })

    const failImmediate = () => Promise.reject(new Error('X'))
    await expect(cb.execute(failImmediate)).rejects.toThrow('X')
    expect(cb.getState()).toBe(CircuitState.OPEN)

    jest.setSystemTime(400)
    await expect(cb.execute(() => Promise.resolve('ok'))).rejects.toBeInstanceOf(
      CircuitBreakerOpenError
    )
    try {
      await cb.execute(() => Promise.resolve('ok'))
    } catch (e: any) {
      expect(e.name).toBe('CircuitBreakerOpenError')
      expect(e.message).toContain(name)
      expect(e.message).toContain('600ms')
    }
  })

  it('OPEN transitions to HALF_OPEN after timeout via getState', async () => {
    jest.useFakeTimers()
    jest.setSystemTime(0)
    const name = `cb-half-open-${Math.random()}`
    const cb = new CircuitBreaker(name, {
      timeoutMs: 1000,
      failureThreshold: 1,
    })

    await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow('fail')
    expect(cb.getState()).toBe(CircuitState.OPEN)

    jest.setSystemTime(1000)
    expect(cb.getState()).toBe(CircuitState.HALF_OPEN)
    const health = cb.getHealthInfo()
    expect(health.metrics.stateTransitions).toBe(2) // CLOSED->OPEN, OPEN->HALF_OPEN
  })

  it('HALF_OPEN allows limited calls then rejects further until transition', async () => {
    jest.useFakeTimers()
    jest.setSystemTime(0)
    const name = `cb-half-open-limit-${Math.random()}`
    const cb = new CircuitBreaker(name, {
      timeoutMs: 1000,
      failureThreshold: 1,
      halfOpenMaxCalls: 2,
      successThreshold: 10,
    })

    await expect(cb.execute(() => Promise.reject(new Error('e')))).rejects.toThrow('e')
    expect(cb.getState()).toBe(CircuitState.OPEN)

    jest.setSystemTime(1001)
    // Now HALF_OPEN
    const p1 = cb.execute(() => new Promise((r) => setTimeout(() => r('A'), 10)))
    jest.advanceTimersByTime(10)
    await expect(p1).resolves.toBe('A')

    const p2 = cb.execute(() => new Promise((r) => setTimeout(() => r('B'), 10)))
    jest.advanceTimersByTime(10)
    await expect(p2).resolves.toBe('B')

    // Third call should be rejected in HALF_OPEN
    const res = await cb.execute(
      () => Promise.resolve('C'),
      () => Promise.resolve('FALLBACK')
    )
    expect(res).toBe('FALLBACK')
    expect(cb.getState()).toBe(CircuitState.HALF_OPEN)

    const health = cb.getHealthInfo()
    expect(health.metrics.rejectedCalls).toBe(1)
  })

  it('HALF_OPEN success reaching threshold closes the breaker and resets failure data', async () => {
    jest.useFakeTimers()
    jest.setSystemTime(0)
    const name = `cb-half-open-close-${Math.random()}`
    const cb = new CircuitBreaker(name, {
      timeoutMs: 1000,
      failureThreshold: 1,
      halfOpenMaxCalls: 5,
      successThreshold: 2,
      slidingWindowSize: 4,
    })

    await expect(cb.execute(() => Promise.reject(new Error('e')))).rejects.toThrow('e')
    expect(cb.getState()).toBe(CircuitState.OPEN)

    jest.setSystemTime(1001)
    const p1 = cb.execute(() => new Promise((r) => setTimeout(() => r('ok1'), 1)))
    jest.advanceTimersByTime(1)
    await p1
    const p2 = cb.execute(() => new Promise((r) => setTimeout(() => r('ok2'), 1)))
    jest.advanceTimersByTime(1)
    await p2

    expect(cb.getState()).toBe(CircuitState.CLOSED)
    const health = cb.getHealthInfo()
    expect(health.failureCount).toBe(0)
    expect(health.successCount).toBe(0)
    expect(health.failureRate).toBe(0)
  })

  it('HALF_OPEN failure immediately transitions to OPEN', async () => {
    jest.useFakeTimers()
    jest.setSystemTime(0)
    const name = `cb-half-open-reopen-${Math.random()}`
    const cb = new CircuitBreaker(name, {
      timeoutMs: 1000,
      failureThreshold: 1,
      halfOpenMaxCalls: 3,
      successThreshold: 2,
    })

    await expect(cb.execute(() => Promise.reject(new Error('f')))).rejects.toThrow('f')
    expect(cb.getState()).toBe(CircuitState.OPEN)

    jest.setSystemTime(1000)
    expect(cb.getState()).toBe(CircuitState.HALF_OPEN)

    const p = cb.execute(() => new Promise<never>((_, rej) => setTimeout(() => rej(new Error('bad')), 1)))
    jest.advanceTimersByTime(1)
    await expect(p).rejects.toThrow('bad')
    expect(cb.getState()).toBe(CircuitState.OPEN)
  })

  it('executeSync handles success and failure and updates metrics', () => {
    const name = `cb-sync-${Math.random()}`
    const cb = new CircuitBreaker(name)

    const result = cb.executeSync(() => 42)
    expect(result).toBe(42)

    expect(() => cb.executeSync(() => { throw new Error('sync-fail') })).toThrow('sync-fail')

    const health = cb.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(2)
    expect(health.metrics.successfulCalls).toBe(1)
    expect(health.metrics.failedCalls).toBe(1)
  })

  it('getHealthInfo exposes metrics and partial config', async () => {
    const name = `cb-health-${Math.random()}`
    const cb = new CircuitBreaker(name, {
      failureThreshold: 7,
      successThreshold: 4,
      timeoutMs: 1234,
    })

    await cb.execute(() => Promise.resolve('ok'))
    try {
      await cb.execute(() => Promise.reject(new Error('x')))
    } catch {
      // ignore
    }

    const info = cb.getHealthInfo()
    expect(info.name).toBe(name)
    expect(info.config.failureThreshold).toBe(7)
    expect(info.config.successThreshold).toBe(4)
    expect(info.config.timeoutMs).toBe(1234)
    expect(info.metrics.totalCalls).toBe(2)
    expect(info.metrics.lastSuccessTime instanceof Date || info.metrics.lastSuccessTime === null).toBe(true)
    expect(info.metrics.lastFailureTime instanceof Date || info.metrics.lastFailureTime === null).toBe(true)
  })

  it('getOrCreate returns the same instance for the same name', () => {
    const name = `cb-registry-${Math.random()}`
    const a = CircuitBreaker.getOrCreate(name, { failureThreshold: 1 })
    const b = CircuitBreaker.getOrCreate(name, { failureThreshold: 999 })
    expect(a).toBe(b)
  })

  it('getRegistry returns a copy and modifying it does not change underlying registry', () => {
    const name = `cb-registry-copy-${Math.random()}`
    const first = CircuitBreaker.getOrCreate(name, { failureThreshold: 1 })
    const r1 = CircuitBreaker.getRegistry()
    expect(r1.has(name)).toBe(true)
    r1.delete(name)
    const r2 = CircuitBreaker.getRegistry()
    expect(r2.has(name)).toBe(true)
    const again = CircuitBreaker.getOrCreate(name, { failureThreshold: 2 })
    expect(again).toBe(first)
  })
})

describe('DistributedCircuitBreakerClient', () => {
  let originalNodeId: string | undefined

  beforeEach(() => {
    ;(global as any).fetch = jest.fn().mockResolvedValue({
      json: async () => ({
        service: 'svc',
        consensusState: CircuitState.CLOSED,
        totalNodes: 1,
        healthScore: 100,
        nodeStates: { n1: CircuitState.CLOSED },
      }),
    })
    originalNodeId = process.env.NODE_ID
  })

  afterEach(() => {
    jest.clearAllMocks()
    process.env.NODE_ID = originalNodeId
    jest.useRealTimers()
  })

  it('register posts to coordinator with breaker info', async () => {
    process.env.NODE_ID = 'test-node'
    const client = new DistributedCircuitBreakerClient('http://coordinator')
    const name = `svc-${Math.random()}`
    const cb = new CircuitBreaker(name, { failureThreshold: 9, successThreshold: 2 })
    client.register(cb)

    await Promise.resolve() // allow async fire-and-forget to run

    expect((global as any).fetch).toHaveBeenCalled()
    const calls = (global as any).fetch.mock.calls
    const registerCall = calls.find((c: any[]) =>
      typeof c[0] === 'string' && c[0].includes('/circuit-breakers/register')
    )
    expect(registerCall).toBeTruthy()
    const body = JSON.parse(registerCall[1].body)
    expect(body.service).toBe(name)
    expect(body.node_id).toBe('test-node')
    expect(body.failure_threshold).toBe(9)
    expect(body.success_threshold).toBe(2)
  })

  it('getAggregatedState returns parsed json on success', async () => {
    const client = new DistributedCircuitBreakerClient('http://coordinator')
    const res = await client.getAggregatedState('payments')
    expect(res.service).toBe('svc')
    expect(res.consensusState).toBe(CircuitState.CLOSED)
    expect(res.totalNodes).toBe(1)
    expect(res.nodeStates.n1).toBe(CircuitState.CLOSED)
  })

  it('getAggregatedState returns default on fetch error', async () => {
    ;(global as any).fetch = jest.fn().mockRejectedValue(new Error('network'))
    const client = new DistributedCircuitBreakerClient('http://coordinator')
    const res = await client.getAggregatedState('billing')
    expect(res.service).toBe('billing')
    expect(res.consensusState).toBe(CircuitState.CLOSED)
    expect(res.totalNodes).toBe(0)
    expect(Object.keys(res.nodeStates).length).toBe(0)
  })

  it('startSync posts state periodically and stopSync stops it', async () => {
    jest.useFakeTimers()
    const fetchMock = (global as any).fetch as jest.Mock
    fetchMock.mockResolvedValue({ json: async () => ({}) })

    const client = new DistributedCircuitBreakerClient('http://coordinator', 1000)
    const name = `svc-sync-${Math.random()}`
    const cb = new CircuitBreaker(name)
    client.register(cb)
    ;(global as any).fetch.mockClear() // clear registration call

    client.startSync()

    jest.advanceTimersByTime(3000)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const paths = fetchMock.mock.calls.map((c) => c[0])
    expect(paths.every((p: string) => p.includes('/circuit-breakers/state'))).toBe(true)

    client.stopSync()
    fetchMock.mockClear()
    jest.advanceTimersByTime(3000)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('withCircuitBreaker decorator', () => {
  afterEach(() => {
    jest.clearAllMocks()
    jest.useRealTimers()
  })

  it('wraps method calls with a named circuit breaker and returns result', async () => {
    class Service {
      @withCircuitBreaker('decor-ok')
      async work(x: number) {
        return x * 2
      }
    }
    const svc = new Service()
    await expect(svc.work(7)).resolves.toBe(14)
  })

  it('reuses the same breaker across calls and opens after failures, then rejects further calls', async () => {
    jest.useFakeTimers()
    jest.setSystemTime(0)
    const name = `decor-open-${Math.random()}`
    class Service {
      @withCircuitBreaker(name, { failureThreshold: 1, timeoutMs: 1000 })
      async risky() {
        throw new Error('bad')
      }
    }
    const svc = new Service()
    await expect(svc.risky()).rejects.toThrow('bad')

    // Next call should be rejected by the breaker immediately
    await expect(svc.risky()).rejects.toBeInstanceOf(CircuitBreakerOpenError)
  })
})