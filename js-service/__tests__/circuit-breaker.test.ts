import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals'
import { CircuitBreaker, CircuitState, CircuitBreakerOpenError, DistributedCircuitBreakerClient, withCircuitBreaker } from '../src/circuit-breaker'

describe('CircuitBreakerOpenError', () => {
  it('should set name and message correctly', () => {
    const err = new CircuitBreakerOpenError('svc', 123.6)
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('CircuitBreakerOpenError')
    expect(err.message).toContain("Circuit breaker 'svc' is open. Retry after 124ms")
    expect(err.remainingTimeMs).toBe(123.6)
  })
})

describe('CircuitBreaker basic behavior', () => {
  afterEach(() => {
    jest.clearAllMocks()
    jest.useRealTimers()
  })

  it('execute success records metrics and returns result', async () => {
    jest.useFakeTimers()
    const cb = new CircuitBreaker('svc-success', { failureThreshold: 3, slidingWindowSize: 2 })
    const op = jest.fn(async () => {
      await new Promise((res) => setTimeout(res, 20))
      return 'done'
    })

    const p = cb.execute(op)
    jest.advanceTimersByTime(20)
    const result = await p

    const health = cb.getHealthInfo()
    expect(result).toBe('done')
    expect(health.metrics.totalCalls).toBe(1)
    expect(health.metrics.successfulCalls).toBe(1)
    expect(health.metrics.failedCalls).toBe(0)
    expect(health.metrics.averageResponseTimeMs).toBeGreaterThanOrEqual(20)
    expect(health.metrics.lastSuccessTime).not.toBeNull()
  })

  it('execute failure increments failure and opens after threshold', async () => {
    const cb = new CircuitBreaker('svc-fail', { failureThreshold: 2, failureRateThreshold: 1, slidingWindowSize: 5 })
    const failingOp = jest.fn(async () => {
      throw new Error('boom')
    })
    await expect(cb.execute(failingOp)).rejects.toThrow('boom')
    expect(cb.getState()).toBe(CircuitState.CLOSED)
    await expect(cb.execute(failingOp)).rejects.toThrow('boom')
    expect(cb.getState()).toBe(CircuitState.OPEN)
    const health = cb.getHealthInfo()
    expect(health.metrics.failedCalls).toBe(2)
  })

  it('execute uses fallback when open and increments rejectedCalls', async () => {
    const cb = new CircuitBreaker('svc-open-fallback', { failureThreshold: 1, timeoutMs: 1000 })
    const failingSync = () => {
      throw new Error('fail-1')
    }
    // Open the circuit
    expect(() => cb.executeSync(failingSync)).toThrow('fail-1')
    expect(cb.getState()).toBe(CircuitState.OPEN)

    const fallback = jest.fn(async () => 'from-fallback')
    const res = await cb.execute(async () => 'should-not-run', fallback)
    expect(res).toBe('from-fallback')
    const health = cb.getHealthInfo()
    expect(health.metrics.rejectedCalls).toBe(1)
  })

  it('half-open transitions to closed after enough successes', () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2020-01-01T00:00:00.000Z'))
    const cb = new CircuitBreaker('svc-half-open-close', {
      failureThreshold: 1,
      successThreshold: 2,
      halfOpenMaxCalls: 2,
      timeoutMs: 1000,
      slidingWindowSize: 2
    })

    // Open it in one failure
    expect(() => cb.executeSync(() => { throw new Error('x') })).toThrow('x')
    expect(cb.getState()).toBe(CircuitState.OPEN)

    // Advance time to allow reset
    jest.setSystemTime(new Date('2020-01-01T00:00:01.100Z'))
    expect(cb.getState()).toBe(CircuitState.HALF_OPEN)

    // Run two successes to close it
    cb.executeSync(() => 1)
    cb.executeSync(() => 2)
    expect(cb.getState()).toBe(CircuitState.CLOSED)
  })

  it('half-open failure transitions back to open', () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2020-01-01T00:00:00.000Z'))
    const cb = new CircuitBreaker('svc-half-open-fail', {
      failureThreshold: 1,
      successThreshold: 2,
      halfOpenMaxCalls: 2,
      timeoutMs: 1000,
      slidingWindowSize: 2
    })
    // Open
    expect(() => cb.executeSync(() => { throw new Error('oops') })).toThrow('oops')
    expect(cb.getState()).toBe(CircuitState.OPEN)
    // Move to half-open
    jest.setSystemTime(new Date('2020-01-01T00:00:01.100Z'))
    expect(cb.getState()).toBe(CircuitState.HALF_OPEN)
    // Fail once in half-open -> goes to open
    expect(() => cb.executeSync(() => { throw new Error('half-fail') })).toThrow('half-fail')
    expect(cb.getState()).toBe(CircuitState.OPEN)
  })

  it('half-open respects halfOpenMaxCalls and rejects extra calls', async () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2020-01-01T00:00:00.000Z'))
    const cb = new CircuitBreaker('svc-half-open-limit', {
      failureThreshold: 1,
      successThreshold: 10,
      halfOpenMaxCalls: 2,
      timeoutMs: 1000,
      slidingWindowSize: 2
    })
    // Open
    expect(() => cb.executeSync(() => { throw new Error('init') })).toThrow('init')
    // Move to half-open
    jest.setSystemTime(new Date('2020-01-01T00:00:01.100Z'))
    expect(cb.getState()).toBe(CircuitState.HALF_OPEN)
    // Two allowed
    const r1 = cb.execute(async () => 'a')
    const r2 = cb.execute(async () => 'b')
    await expect(r1).resolves.toBe('a')
    await expect(r2).resolves.toBe('b')
    // Third should be rejected
    await expect(cb.execute(async () => 'c')).rejects.toBeInstanceOf(CircuitBreakerOpenError)
    const err = await cb.execute(async () => 'd').catch(e => e)
    expect(err).toBeInstanceOf(CircuitBreakerOpenError)
    expect((err as CircuitBreakerOpenError).remainingTimeMs).toBe(0)
  })

  it('sliding window failure rate triggers open', () => {
    const cb = new CircuitBreaker('svc-rate', {
      failureThreshold: 100,
      failureRateThreshold: 0.5,
      slidingWindowSize: 2
    })
    expect(() => cb.executeSync(() => { throw new Error('f1') })).toThrow('f1')
    expect(cb.getState()).toBe(CircuitState.CLOSED)
    expect(() => cb.executeSync(() => { throw new Error('f2') })).toThrow('f2')
    expect(cb.getState()).toBe(CircuitState.OPEN)
  })

  it('executeSync success and failure behavior', () => {
    const cb = new CircuitBreaker('svc-sync', { failureThreshold: 2, slidingWindowSize: 2 })
    const r = cb.executeSync(() => 42)
    expect(r).toBe(42)
    expect(() => cb.executeSync(() => { throw new Error('boom') })).toThrow('boom')
    const health = cb.getHealthInfo()
    expect(health.metrics.successfulCalls).toBe(1)
    expect(health.metrics.failedCalls).toBe(1)
  })

  it('getState remains open before timeout, then becomes half-open after timeout', () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2020-01-01T00:00:00.000Z'))
    const cb = new CircuitBreaker('svc-time', { failureThreshold: 1, timeoutMs: 2000 })
    expect(() => cb.executeSync(() => { throw new Error('x') })).toThrow('x')
    expect(cb.getState()).toBe(CircuitState.OPEN)
    // Before timeout
    jest.setSystemTime(new Date('2020-01-01T00:00:01.000Z'))
    expect(cb.getState()).toBe(CircuitState.OPEN)
    // After timeout
    jest.setSystemTime(new Date('2020-01-01T00:00:02.100Z'))
    expect(cb.getState()).toBe(CircuitState.HALF_OPEN)
  })

  it('average response time updates over multiple calls', async () => {
    jest.useFakeTimers()
    jest.setSystemTime(0)
    const cb = new CircuitBreaker('svc-avg', { slidingWindowSize: 5 })
    const op10 = jest.fn(async () => {
      await new Promise(res => setTimeout(res, 10))
      return 1
    })
    const op30 = jest.fn(async () => {
      await new Promise(res => setTimeout(res, 30))
      return 2
    })

    const p1 = cb.execute(op10)
    jest.advanceTimersByTime(10)
    await p1
    const p2 = cb.execute(op30)
    jest.advanceTimersByTime(30)
    await p2

    const avg = cb.getHealthInfo().metrics.averageResponseTimeMs
    expect(avg).toBeGreaterThanOrEqual(20)
    expect(avg).toBeLessThanOrEqual(20)
  })

  it('health info contains expected structure and config', () => {
    const cb = new CircuitBreaker('svc-health', { failureThreshold: 7, successThreshold: 2, timeoutMs: 1234 })
    cb.executeSync(() => 1)
    try { cb.executeSync(() => { throw new Error('oops') }) } catch {}
    const info = cb.getHealthInfo()
    expect(info.name).toBe('svc-health')
    expect([CircuitState.CLOSED, CircuitState.OPEN, CircuitState.HALF_OPEN]).toContain(info.state)
    expect(info.metrics.totalCalls).toBe(2)
    expect(info.config.failureThreshold).toBe(7)
    expect(info.config.successThreshold).toBe(2)
    expect(info.config.timeoutMs).toBe(1234)
  })

  it('closed state success decreases failureCount', () => {
    const cb = new CircuitBreaker('svc-failure-decrease', { failureThreshold: 10 })
    try { cb.executeSync(() => { throw new Error('a') }) } catch {}
    try { cb.executeSync(() => { throw new Error('b') }) } catch {}
    let info = cb.getHealthInfo()
    expect(info.failureCount).toBe(2)
    cb.executeSync(() => 'ok')
    info = cb.getHealthInfo()
    expect(info.failureCount).toBe(1)
  })
})

describe('CircuitBreaker registry', () => {
  afterEach(() => {
    jest.clearAllMocks()
    jest.useRealTimers()
  })

  it('getOrCreate returns singleton and getRegistry is a copy', () => {
    const a = CircuitBreaker.getOrCreate('singleton', { failureThreshold: 2 })
    const b = CircuitBreaker.getOrCreate('singleton', { failureThreshold: 99 })
    expect(a).toBe(b)

    const reg1 = CircuitBreaker.getRegistry()
    reg1.set('mutate', new CircuitBreaker('mutated'))
    const reg2 = CircuitBreaker.getRegistry()
    expect(reg2.has('mutate')).toBe(false)
    expect(reg2.get('singleton')).toBeDefined()
  })
})

describe('DistributedCircuitBreakerClient', () => {
  const originalEnv = { ...process.env }
  beforeEach(() => {
    process.env.NODE_ID = 'node-test'
    ;(global as any).fetch = jest.fn().mockResolvedValue({ json: jest.fn().mockResolvedValue({}) })
  })
  afterEach(() => {
    process.env = { ...originalEnv }
    jest.clearAllMocks()
    jest.useRealTimers()
  })

  it('register sends registration payload', async () => {
    const client = new DistributedCircuitBreakerClient('http://coordinator')
    const cb = new CircuitBreaker('reg-svc', { failureThreshold: 4, successThreshold: 2 })
    client.register(cb)
    await Promise.resolve()
    expect((global as any).fetch).toHaveBeenCalled()
    const [url, opts] = (global as any).fetch.mock.calls[0]
    expect(url).toBe('http://coordinator/circuit-breakers/register')
    expect(opts.method).toBe('POST')
    const body = JSON.parse(opts.body)
    expect(body.service).toBe('reg-svc')
    expect(body.node_id).toBe('node-test')
    expect(body.failure_threshold).toBe(4)
    expect(body.success_threshold).toBe(2)
  })

  it('startSync posts state periodically and stopSync cancels', async () => {
    jest.useFakeTimers()
    const fetchMock = (global as any).fetch as jest.Mock
    fetchMock.mockResolvedValue({ json: jest.fn().mockResolvedValue({}) })

    const client = new DistributedCircuitBreakerClient('http://coordinator', 500)
    const cb1 = new CircuitBreaker('svc1')
    const cb2 = new CircuitBreaker('svc2')
    client.register(cb1)
    client.register(cb2)

    client.startSync()
    jest.advanceTimersByTime(500)
    await Promise.resolve()
    expect(fetchMock).toHaveBeenCalled()
    const callsAfterFirstTick = fetchMock.mock.calls.length
    // Two breakers -> two posts
    expect(callsAfterFirstTick % 2).toBe(0)
    for (let i = 0; i < callsAfterFirstTick; i++) {
      const [url, opts] = fetchMock.mock.calls[i]
      if (typeof url === 'string' && url.endsWith('/state')) {
        expect(opts.method).toBe('POST')
        const body = JSON.parse(opts.body)
        expect(body.service === 'svc1' || body.service === 'svc2').toBe(true)
        expect(body.node_id).toBe('node-test')
        expect([CircuitState.CLOSED, CircuitState.OPEN, CircuitState.HALF_OPEN]).toContain(body.state)
        expect(typeof body.timestamp).toBe('number')
        expect(body.health_info.name === 'svc1' || body.health_info.name === 'svc2').toBe(true)
      }
    }

    fetchMock.mockClear()
    client.stopSync()
    jest.advanceTimersByTime(1000)
    await Promise.resolve()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('getAggregatedState returns parsed data on success', async () => {
    const data = {
      service: 'agg',
      consensusState: CircuitState.CLOSED,
      totalNodes: 3,
      healthScore: 0.9,
      nodeStates: { a: CircuitState.CLOSED }
    }
    ;(global as any).fetch = jest.fn().mockResolvedValue({ json: jest.fn().mockResolvedValue(data) })
    const client = new DistributedCircuitBreakerClient('http://coordinator')
    const res = await client.getAggregatedState('agg')
    expect(res).toEqual(data)
  })

  it('getAggregatedState returns defaults on error', async () => {
    ;(global as any).fetch = jest.fn().mockRejectedValue(new Error('network'))
    const client = new DistributedCircuitBreakerClient('http://coordinator')
    const res = await client.getAggregatedState('agg2')
    expect(res.service).toBe('agg2')
    expect(res.consensusState).toBe(CircuitState.CLOSED)
    expect(res.totalNodes).toBe(0)
    expect(res.nodeStates).toEqual({})
  })
})

describe('withCircuitBreaker decorator', () => {
  afterEach(() => {
    jest.clearAllMocks()
  })

  it('wraps method to execute via breaker', async () => {
    const executeMock = jest.fn(async (fn: any) => await fn())
    const breakerMock = { execute: executeMock } as unknown as CircuitBreaker
    const spy = jest.spyOn(CircuitBreaker, 'getOrCreate').mockReturnValue(breakerMock)

    class Service {
      async compute(x: number) {
        return x * 2
      }
    }
    const decorator = withCircuitBreaker('decorated-svc')
    const desc = Object.getOwnPropertyDescriptor(Service.prototype, 'compute')!
    decorator(Service.prototype, 'compute', desc)
    Object.defineProperty(Service.prototype, 'compute', desc)

    const s = new Service()
    const result = await (s as any).compute(5)
    expect(result).toBe(10)
    expect(spy).toHaveBeenCalledWith('decorated-svc', undefined)
    expect(executeMock).toHaveBeenCalledTimes(1)
    expect(typeof executeMock.mock.calls[0][0]).toBe('function')
  })
})