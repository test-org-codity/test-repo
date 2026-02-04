import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals'
import { CircuitBreaker, CircuitBreakerOpenError, CircuitState, DistributedCircuitBreakerClient, withCircuitBreaker } from '../src/circuit-breaker'

describe('CircuitBreakerOpenError', () => {
  it('sets name to CircuitBreakerOpenError and formats message and remaining time', () => {
    const err = new CircuitBreakerOpenError('my-service', 1234.56)
    expect(err).toBeInstanceOf(CircuitBreakerOpenError)
    expect(err.name).toBe('CircuitBreakerOpenError')
    expect(err.remainingTimeMs).toBe(1234.56)
    expect(err.message).toContain("Circuit breaker 'my-service' is open")
    expect(err.message).toContain('Retry after 1235ms')
  })
})

describe('CircuitBreaker basic behavior', () => {
  afterEach(() => {
    jest.clearAllMocks()
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  it('starts in CLOSED state and reports initial health', () => {
    const breaker = new CircuitBreaker('svc-initial')
    expect(breaker.getState()).toBe(CircuitState.CLOSED)

    const health = breaker.getHealthInfo()
    expect(health.name).toBe('svc-initial')
    expect(health.state).toBe(CircuitState.CLOSED)
    expect(health.failureCount).toBe(0)
    expect(health.successCount).toBe(0)
    expect(health.metrics.totalCalls).toBe(0)
    expect(health.metrics.averageResponseTimeMs).toBe(0)
    expect(health.metrics.lastFailureTime).toBeNull()
    expect(health.metrics.lastSuccessTime).toBeNull()
    expect(health.config.failureThreshold).toBeDefined()
    expect(health.config.successThreshold).toBeDefined()
    expect(health.config.timeoutMs).toBeDefined()
  })

  it('execute() success updates metrics and stays CLOSED', async () => {
    const breaker = new CircuitBreaker('svc-success')
    const res = await breaker.execute(async () => 'ok')
    expect(res).toBe('ok')

    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(1)
    expect(health.metrics.successfulCalls).toBe(1)
    expect(health.metrics.failedCalls).toBe(0)
    expect(health.metrics.lastSuccessTime).toBeInstanceOf(Date)
    expect(health.state).toBe(CircuitState.CLOSED)
  })

  it('execute() failure updates failureCount and metrics', async () => {
    const breaker = new CircuitBreaker('svc-failure', { failureThreshold: 5 })
    await expect(breaker.execute(async () => { throw new Error('boom') }))
      .rejects.toThrow('boom')

    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(1)
    expect(health.metrics.failedCalls).toBe(1)
    expect(health.metrics.successfulCalls).toBe(0)
    expect(health.metrics.lastFailureTime).toBeInstanceOf(Date)
    expect(health.failureCount).toBe(1)
    expect(health.state).toBe(CircuitState.CLOSED)
  })

  it('opens when failures reach failureThreshold', async () => {
    const breaker = new CircuitBreaker('svc-open-threshold', { failureThreshold: 2, timeoutMs: 10000, failureRateThreshold: 1 })
    await expect(breaker.execute(async () => { throw new Error('e1') })).rejects.toThrow('e1')
    expect(breaker.getState()).toBe(CircuitState.CLOSED)
    await expect(breaker.execute(async () => { throw new Error('e2') })).rejects.toThrow('e2')
    expect(breaker.getState()).toBe(CircuitState.OPEN)
  })

  it('rejects new requests when OPEN without fallback and throws CircuitBreakerOpenError', async () => {
    const breaker = new CircuitBreaker('svc-open-reject', { failureThreshold: 1, timeoutMs: 5000 })
    await expect(breaker.execute(async () => { throw new Error('fail') })).rejects.toThrow('fail')
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    await expect(breaker.execute(async () => 'ok')).rejects.toBeInstanceOf(CircuitBreakerOpenError)
    const health = breaker.getHealthInfo()
    expect(health.metrics.rejectedCalls).toBe(1)
  })

  it('uses fallback when OPEN and increments rejectedCalls', async () => {
    const breaker = new CircuitBreaker('svc-open-fallback', { failureThreshold: 1, timeoutMs: 5000 })
    await expect(breaker.execute(async () => { throw new Error('oops') })).rejects.toThrow('oops')
    expect(breaker.getState()).toBe(CircuitState.OPEN)
    const result = await breaker.execute(async () => 'primary', async () => 'fallback')
    expect(result).toBe('fallback')
    const health = breaker.getHealthInfo()
    expect(health.metrics.rejectedCalls).toBe(1)
  })

  it('transitions to HALF_OPEN after timeout passes', async () => {
    jest.useFakeTimers()
    const breaker = new CircuitBreaker('svc-half-open', { failureThreshold: 1, timeoutMs: 1000 })
    await expect(breaker.execute(async () => { throw new Error('x') })).rejects.toThrow('x')
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    jest.advanceTimersByTime(1001)
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)
  })

  it('limits calls in HALF_OPEN by halfOpenMaxCalls and rejects excess with fallback', async () => {
    jest.useFakeTimers()
    const breaker = new CircuitBreaker('svc-half-open-limit', { failureThreshold: 1, timeoutMs: 1000, halfOpenMaxCalls: 2 })
    await expect(breaker.execute(async () => { throw new Error('x') })).rejects.toThrow('x')
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    jest.advanceTimersByTime(1001)
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)

    const ok1 = await breaker.execute(async () => 'ok1')
    const ok2 = await breaker.execute(async () => 'ok2')
    expect(ok1).toBe('ok1')
    expect(ok2).toBe('ok2')

    const result = await breaker.execute(async () => 'should-not-run', async () => 'fallback')
    expect(result).toBe('fallback')
    const health = breaker.getHealthInfo()
    expect(health.metrics.rejectedCalls).toBe(1)
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)
  })

  it('fails in HALF_OPEN and transitions back to OPEN immediately', async () => {
    jest.useFakeTimers()
    const breaker = new CircuitBreaker('svc-half-open-fail', { failureThreshold: 1, timeoutMs: 1000 })
    await expect(breaker.execute(async () => { throw new Error('e') })).rejects.toThrow('e')
    expect(breaker.getState()).toBe(CircuitState.OPEN)
    jest.advanceTimersByTime(1001)
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)

    await expect(breaker.execute(async () => { throw new Error('half-open-fail') })).rejects.toThrow('half-open-fail')
    expect(breaker.getState()).toBe(CircuitState.OPEN)
  })

  it('closes from HALF_OPEN after successThreshold successes', async () => {
    jest.useFakeTimers()
    const breaker = new CircuitBreaker('svc-half-open-success', { failureThreshold: 1, timeoutMs: 1000, successThreshold: 2, halfOpenMaxCalls: 5 })
    await expect(breaker.execute(async () => { throw new Error('e') })).rejects.toThrow('e')
    expect(breaker.getState()).toBe(CircuitState.OPEN)
    jest.advanceTimersByTime(1001)
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)

    const r1 = await breaker.execute(async () => 's1')
    const r2 = await breaker.execute(async () => 's2')
    expect(r1).toBe('s1')
    expect(r2).toBe('s2')
    expect(breaker.getState()).toBe(CircuitState.CLOSED)

    const health = breaker.getHealthInfo()
    expect(health.failureCount).toBe(0)
    expect(health.successCount).toBe(0)
  })

  it('opens due to failure rate threshold via sliding window', async () => {
    const breaker = new CircuitBreaker('svc-failure-rate', {
      failureThreshold: 1000,
      slidingWindowSize: 4,
      failureRateThreshold: 0.5,
    })

    await expect(breaker.execute(async () => { throw new Error('f1') })).rejects.toThrow('f1')
    expect(breaker.getState()).toBe(CircuitState.CLOSED)
    await expect(breaker.execute(async () => { throw new Error('f2') })).rejects.toThrow('f2')
    expect(breaker.getState()).toBe(CircuitState.OPEN)
  })

  it('calculates averageResponseTimeMs over recent calls', async () => {
    const breaker = new CircuitBreaker('svc-avg-time')

    const spy = jest.spyOn(Date, 'now')
    spy.mockReturnValueOnce(1000) // start 1
    spy.mockReturnValueOnce(1100) // end 1 (duration 100)
    await breaker.execute(async () => 'a')

    spy.mockReturnValueOnce(2000) // start 2
    spy.mockReturnValueOnce(2300) // end 2 (duration 300)
    await breaker.execute(async () => 'b')

    const avg = breaker.getHealthInfo().metrics.averageResponseTimeMs
    expect(avg).toBe(200)
  })

  it('executeSync success and failure update metrics correctly', () => {
    const breaker = new CircuitBreaker('svc-sync')

    const result = breaker.executeSync(() => 42)
    expect(result).toBe(42)

    expect(() => breaker.executeSync(() => { throw new Error('sync-fail') })).toThrow('sync-fail')

    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(2)
    expect(health.metrics.successfulCalls).toBe(1)
    expect(health.metrics.failedCalls).toBe(1)
  })

  it('executeSync throws CircuitBreakerOpenError when OPEN without fallback', () => {
    const breaker = new CircuitBreaker('svc-sync-open', { failureThreshold: 1, timeoutMs: 5000 })
    expect(() => breaker.executeSync(() => { throw new Error('sync fail') })).toThrow('sync fail')
    expect(breaker.getState()).toBe(CircuitState.OPEN)
    expect(() => breaker.executeSync(() => 1)).toThrow(CircuitBreakerOpenError)
    const health = breaker.getHealthInfo()
    expect(health.metrics.rejectedCalls).toBe(1)
  })

  it('getOrCreate returns same instance for same name', () => {
    const a = CircuitBreaker.getOrCreate('registry-same', { failureThreshold: 2 })
    const b = CircuitBreaker.getOrCreate('registry-same', { failureThreshold: 99 })
    expect(a).toBe(b)
    expect(b.getHealthInfo().name).toBe('registry-same')
  })
})

describe('DistributedCircuitBreakerClient', () => {
  const originalEnv = process.env
  beforeEach(() => {
    jest.clearAllMocks()
    ;(globalThis as any).fetch = jest.fn().mockResolvedValue({
      json: async () => ({ ok: true }),
    })
    process.env = { ...originalEnv, NODE_ID: 'node-123' }
  })

  afterEach(() => {
    jest.clearAllMocks()
    jest.useRealTimers()
    process.env = originalEnv
  })

  it('register sends registration payload with thresholds', async () => {
    const breaker = new CircuitBreaker('svc-register', { failureThreshold: 7, successThreshold: 4 })
    const client = new DistributedCircuitBreakerClient('http://coordinator.test', 10000)

    client.register(breaker)
    await Promise.resolve()

    expect((globalThis as any).fetch).toHaveBeenCalledWith(
      'http://coordinator.test/circuit-breakers/register',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
    )
    const bodyStr = (globalThis as any).fetch.mock.calls[0][1].body as string
    const body = JSON.parse(bodyStr)
    expect(body.service).toBe('svc-register')
    expect(body.node_id).toBe('node-123')
    expect(body.failure_threshold).toBe(7)
    expect(body.success_threshold).toBe(4)
  })

  it('getAggregatedState returns JSON on success', async () => {
    ;(globalThis as any).fetch = jest.fn().mockResolvedValue({
      json: async () => ({
        service: 'svc-agg',
        consensusState: 'CLOSED',
        totalNodes: 3,
        healthScore: 0.9,
        nodeStates: { a: 'CLOSED', b: 'OPEN', c: 'CLOSED' },
      }),
    })
    const client = new DistributedCircuitBreakerClient('http://coordinator.test')
    const agg = await client.getAggregatedState('svc-agg')
    expect(agg.service).toBe('svc-agg')
    expect(agg.totalNodes).toBe(3)
    expect(agg.nodeStates.b).toBe('OPEN')
  })

  it('getAggregatedState returns default on fetch error', async () => {
    ;(globalThis as any).fetch = jest.fn().mockRejectedValue(new Error('network'))
    const client = new DistributedCircuitBreakerClient('http://coordinator.test')
    const agg = await client.getAggregatedState('svc-unknown')
    expect(agg.service).toBe('svc-unknown')
    expect(agg.consensusState).toBe(CircuitState.CLOSED)
    expect(agg.totalNodes).toBe(0)
    expect(agg.nodeStates).toEqual({})
  })

  it('startSync periodically reports state, stopSync stops it', async () => {
    jest.useFakeTimers()
    const client = new DistributedCircuitBreakerClient('http://coordinator.test', 2000)
    const breaker = new CircuitBreaker('svc-sync-report')
    client.register(breaker)
    await Promise.resolve()

    ;(globalThis as any).fetch.mockClear()

    client.startSync()
    jest.advanceTimersByTime(2100)
    expect((globalThis as any).fetch).toHaveBeenCalledTimes(1)
    const [url, init] = (globalThis as any).fetch.mock.calls[0]
    expect(url).toBe('http://coordinator.test/circuit-breakers/state')
    expect(init.method).toBe('POST')
    const payload = JSON.parse(init.body)
    expect(payload.service).toBe('svc-sync-report')
    expect(payload.node_id).toBe('node-123')
    expect(payload.state).toBe(CircuitState.CLOSED)
    expect(payload.health_info.name).toBe('svc-sync-report')

    ;(globalThis as any).fetch.mockClear()
    client.stopSync()
    jest.advanceTimersByTime(4000)
    expect((globalThis as any).fetch).not.toHaveBeenCalled()
  })
})

describe('withCircuitBreaker decorator', () => {
  afterEach(() => {
    jest.clearAllMocks()
  })

  it('wraps method with breaker.execute and preserves this/args', async () => {
    const name = `decor-${Math.random()}`
    class Example {
      factor = 3
      @withCircuitBreaker(name)
      async multiply(x: number, y: number) {
        return (x + y) * this.factor
      }
    }
    const breaker = CircuitBreaker.getOrCreate(name)
    const execSpy = jest.spyOn(breaker, 'execute').mockImplementation(async (op: any) => {
      return op()
    })
    const inst = new Example()
    const result = await (inst as any).multiply(2, 5)
    expect(result).toBe((2 + 5) * 3)
    expect(execSpy).toHaveBeenCalledTimes(1)
    const arg = execSpy.mock.calls[0][0]
    expect(typeof arg).toBe('function')
  })

  it('uses existing breaker instance for the same name', async () => {
    const name = `decor-shared-${Math.random()}`
    class ExampleA {
      @withCircuitBreaker(name)
      async foo() {
        return 'A'
      }
    }
    class ExampleB {
      @withCircuitBreaker(name)
      async bar() {
        return 'B'
      }
    }
    const breaker = CircuitBreaker.getOrCreate(name)
    const execSpy = jest.spyOn(breaker, 'execute').mockImplementation(async (op: any) => op())

    const a = new ExampleA()
    const b = new ExampleB()

    const ra = await (a as any).foo()
    const rb = await (b as any).bar()

    expect(ra).toBe('A')
    expect(rb).toBe('B')
    expect(execSpy).toHaveBeenCalledTimes(2)
  })
})