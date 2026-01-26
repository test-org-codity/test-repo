import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals'
import { CircuitBreaker, CircuitBreakerOpenError, CircuitState, DistributedCircuitBreakerClient, withCircuitBreaker } from '../src/circuit-breaker'

describe('CircuitBreakerOpenError', () => {
  it('sets name and message with remaining time', () => {
    const err = new CircuitBreakerOpenError('svc', 1234.6)
    expect(err.name).toBe('CircuitBreakerOpenError')
    expect(err.message).toContain("Circuit breaker 'svc' is open. Retry after 1235ms")
  })
})

describe('CircuitBreaker basic behavior', () => {
  afterEach(() => {
    jest.clearAllMocks()
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  it('starts CLOSED and records success/failure counts in health info', async () => {
    const breaker = new CircuitBreaker('cb-basic-1', { failureThreshold: 10 })
    expect(breaker.getState()).toBe(CircuitState.CLOSED)

    // First a failure
    await expect(
      breaker.execute(async () => {
        throw new Error('fail')
      })
    ).rejects.toThrow('fail')
    let health = breaker.getHealthInfo()
    expect(health.failureCount).toBe(1)
    expect(health.metrics.failedCalls).toBe(1)
    expect(health.metrics.lastFailureTime).not.toBeNull()

    // Then a success which decrements failureCount
    const result = await breaker.execute(async () => 42)
    expect(result).toBe(42)
    health = breaker.getHealthInfo()
    expect(health.failureCount).toBe(0)
    expect(health.metrics.successfulCalls).toBe(1)
    expect(health.metrics.lastSuccessTime).not.toBeNull()
  })

  it('opens after reaching failureThreshold and rejects further calls', async () => {
    let now = 0
    const spyNow = jest.spyOn(Date, 'now').mockImplementation(() => now)
    const breaker = new CircuitBreaker('cb-open-1', {
      failureThreshold: 2,
      timeoutMs: 1000,
      slidingWindowSize: 10,
      failureRateThreshold: 1 // ensure rate alone doesn't trip
    })

    // Cause two failures
    await expect(breaker.execute(async () => { throw new Error('e1') })).rejects.toThrow('e1')
    await expect(breaker.execute(async () => { throw new Error('e2') })).rejects.toThrow('e2')
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    // Next call should be rejected with open error and not count as totalCalls
    const before = breaker.getHealthInfo().metrics.totalCalls
    now = 100 // simulate time progressed
    await expect(breaker.execute(async () => 1)).rejects.toBeInstanceOf(CircuitBreakerOpenError)
    const after = breaker.getHealthInfo().metrics.totalCalls
    expect(after).toBe(before) // not incremented when rejected
    expect(breaker.getHealthInfo().metrics.rejectedCalls).toBe(1)

    spyNow.mockRestore()
  })

  it('half-open after timeout and closes after success threshold is met', async () => {
    let now = 0
    jest.spyOn(Date, 'now').mockImplementation(() => now)
    const breaker = new CircuitBreaker('cb-halfopen-close-1', {
      failureThreshold: 1,
      successThreshold: 2,
      timeoutMs: 500,
      halfOpenMaxCalls: 5,
      slidingWindowSize: 10,
      failureRateThreshold: 1
    })

    // Open it
    await expect(breaker.execute(async () => { throw new Error('oops') })).rejects.toThrow('oops')
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    // Advance beyond timeout to become HALF_OPEN on next getState/allowRequest
    now = 600
    // First half-open success
    await expect(breaker.execute(async () => 'A')).resolves.toBe('A')
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)
    // Second half-open success should close
    await expect(breaker.execute(async () => 'B')).resolves.toBe('B')
    expect(breaker.getState()).toBe(CircuitState.CLOSED)
  })

  it('in HALF_OPEN a failure immediately transitions back to OPEN', async () => {
    let now = 0
    jest.spyOn(Date, 'now').mockImplementation(() => now)
    const breaker = new CircuitBreaker('cb-halfopen-fail-1', {
      failureThreshold: 1,
      successThreshold: 2,
      timeoutMs: 1000,
      halfOpenMaxCalls: 5,
      slidingWindowSize: 10,
      failureRateThreshold: 1
    })

    // Open it
    await expect(breaker.execute(async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    // Move into HALF_OPEN
    now = 1500
    await expect(breaker.execute(async () => { throw new Error('half-open fail') })).rejects.toThrow('half-open fail')
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    // Try again before timeout, should be rejected
    await expect(breaker.execute(async () => 1)).rejects.toBeInstanceOf(CircuitBreakerOpenError)
  })

  it('enforces halfOpenMaxCalls gating', async () => {
    let now = 0
    jest.spyOn(Date, 'now').mockImplementation(() => now)
    const breaker = new CircuitBreaker('cb-halfopen-gate-1', {
      failureThreshold: 1,
      successThreshold: 10,
      timeoutMs: 1000,
      halfOpenMaxCalls: 2,
      slidingWindowSize: 10,
      failureRateThreshold: 1
    })

    // Open it
    await expect(breaker.execute(async () => { throw new Error('trip') })).rejects.toThrow()
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    // move to half-open
    now = 2000
    await expect(breaker.execute(async () => 'ok1')).resolves.toBe('ok1')
    await expect(breaker.execute(async () => 'ok2')).resolves.toBe('ok2')
    // third call in HALF_OPEN should be rejected due to max calls
    await expect(breaker.execute(async () => 'blocked')).rejects.toBeInstanceOf(CircuitBreakerOpenError)
    const metrics = breaker.getHealthInfo().metrics
    expect(metrics.rejectedCalls).toBe(1)
  })

  it('opens due to failure rate threshold based on sliding window', async () => {
    const breaker = new CircuitBreaker('cb-failrate-1', {
      failureThreshold: 100,
      slidingWindowSize: 4,
      failureRateThreshold: 0.5,
      timeoutMs: 5000
    })

    await expect(breaker.execute(async () => { throw new Error('f1') })).rejects.toThrow('f1')
    await expect(breaker.execute(async () => { throw new Error('f2') })).rejects.toThrow('f2')
    expect(breaker.getState()).toBe(CircuitState.OPEN)
  })

  it('sliding window calculates failureRate correctly without opening when threshold is high', async () => {
    const breaker = new CircuitBreaker('cb-window-rate-1', {
      failureThreshold: 100,
      slidingWindowSize: 3,
      failureRateThreshold: 1.0 // will not open
    })

    await expect(breaker.execute(async () => { throw new Error('f') })).rejects.toThrow()
    await expect(breaker.execute(async () => { throw new Error('f') })).rejects.toThrow()
    await breaker.execute(async () => 's')

    const health = breaker.getHealthInfo()
    expect(health.state).toBe(CircuitState.CLOSED)
    expect(health.failureRate).toBeCloseTo(2 / 3)
  })

  it('computes averageResponseTimeMs from last up to 100 calls', async () => {
    let now = 0
    jest.spyOn(Date, 'now').mockImplementation(() => now)
    const breaker = new CircuitBreaker('cb-avg-1', {})

    await breaker.execute(async () => {
      now += 100
      return 'x'
    })
    await breaker.execute(async () => {
      now += 200
      return 'y'
    })

    const avg = breaker.getHealthInfo().metrics.averageResponseTimeMs
    expect(avg).toBeCloseTo(150)
  })

  it('execute fallback is used when breaker is OPEN and rejectedCalls increments', async () => {
    let now = 0
    jest.spyOn(Date, 'now').mockImplementation(() => now)
    const breaker = new CircuitBreaker('cb-fallback-1', {
      failureThreshold: 1,
      timeoutMs: 1000
    })

    await expect(breaker.execute(async () => { throw new Error('fail') })).rejects.toThrow()
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    const before = breaker.getHealthInfo().metrics.totalCalls
    const v = await breaker.execute(async () => 1, async () => 999)
    expect(v).toBe(999)
    const metrics = breaker.getHealthInfo().metrics
    expect(metrics.rejectedCalls).toBe(1)
    expect(metrics.totalCalls).toBe(before)
  })

  it('executeSync works and supports fallback when OPEN', () => {
    let now = 0
    jest.spyOn(Date, 'now').mockImplementation(() => now)
    const breaker = new CircuitBreaker('cb-sync-1', {
      failureThreshold: 1,
      timeoutMs: 1000
    })

    expect(() => breaker.executeSync(() => { throw new Error('oops') })).toThrow('oops')
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    const ret = breaker.executeSync(() => 10, () => 77)
    expect(ret).toBe(77)
    const metrics = breaker.getHealthInfo().metrics
    expect(metrics.rejectedCalls).toBe(1)
  })
})

describe('CircuitBreaker registry', () => {
  afterEach(() => {
    jest.clearAllMocks()
  })

  it('getOrCreate returns same instance for same name', () => {
    const a = CircuitBreaker.getOrCreate('cb-registry-1', { failureThreshold: 2 })
    const b = CircuitBreaker.getOrCreate('cb-registry-1', { failureThreshold: 5 })
    expect(a).toBe(b)
    // Config used is from first creation; verify via health info
    const cfg = a.getHealthInfo().config
    expect(cfg.failureThreshold).toBe(2)
  })

  it('getRegistry returns a copy, modifications do not affect internal registry', () => {
    const copy1 = CircuitBreaker.getRegistry()
    copy1.set('temp-cb', new CircuitBreaker('temp-cb'))
    const copy2 = CircuitBreaker.getRegistry()
    expect(copy2.has('temp-cb')).toBe(false)
  })
})

describe('DistributedCircuitBreakerClient', () => {
  let originalEnv: NodeJS.ProcessEnv
  let fetchMock: jest.Mock

  beforeEach(() => {
    originalEnv = { ...process.env }
    process.env.NODE_ID = 'node-123'
    fetchMock = jest.fn().mockResolvedValue({
      json: jest.fn().mockResolvedValue({ ok: true })
    })
    ;(global as any).fetch = fetchMock
  })

  afterEach(() => {
    jest.clearAllMocks()
    process.env = originalEnv
    delete (global as any).fetch
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  it('register sends registration with thresholds and node_id', async () => {
    const client = new DistributedCircuitBreakerClient('http://coordinator.test', 1000)
    const breaker = new CircuitBreaker('svc-reg-1', { failureThreshold: 7, successThreshold: 4 })
    client.register(breaker)

    // wait for async sendRegistration
    await Promise.resolve()
    expect(fetchMock).toHaveBeenCalled()
    const call = fetchMock.mock.calls.find(c => String(c[0]).includes('/circuit-breakers/register'))!
    expect(call).toBeTruthy()
    const body = JSON.parse(call[1].body)
    expect(body.service).toBe('svc-reg-1')
    expect(body.node_id).toBe('node-123')
    expect(body.failure_threshold).toBe(7)
    expect(body.success_threshold).toBe(4)
  })

  it('getAggregatedState returns server response', async () => {
    const agg = {
      service: 'svc-agg-1',
      consensusState: CircuitState.HALF_OPEN,
      totalNodes: 3,
      healthScore: 0.8,
      nodeStates: { a: CircuitState.CLOSED }
    }
    fetchMock.mockResolvedValueOnce({
      json: jest.fn().mockResolvedValue(agg)
    })
    const client = new DistributedCircuitBreakerClient('http://coordinator.test')
    const res = await client.getAggregatedState('svc-agg-1')
    expect(res).toEqual(agg)
    expect(fetchMock).toHaveBeenCalledWith('http://coordinator.test/circuit-breakers/svc-agg-1/aggregate')
  })

  it('getAggregatedState returns defaults on fetch error', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network'))
    const client = new DistributedCircuitBreakerClient('http://coordinator.test')
    const res = await client.getAggregatedState('svc-agg-err')
    expect(res.service).toBe('svc-agg-err')
    expect(res.consensusState).toBe(CircuitState.CLOSED)
    expect(res.totalNodes).toBe(0)
    expect(res.healthScore).toBe(0)
    expect(res.nodeStates).toEqual({})
  })

  it('startSync periodically reports state and stopSync cancels interval', async () => {
    jest.useFakeTimers()
    const client = new DistributedCircuitBreakerClient('http://coordinator.test', 2000)
    const breaker = new CircuitBreaker('svc-sync-1')
    client.register(breaker)
    await Promise.resolve()
    fetchMock.mockClear() // clear registration call

    client.startSync()
    jest.advanceTimersByTime(2000)
    await Promise.resolve()
    // Expect a /state call
    const hasStateCall = fetchMock.mock.calls.some(c => String(c[0]).includes('/circuit-breakers/state'))
    expect(hasStateCall).toBe(true)

    fetchMock.mockClear()
    client.stopSync()
    jest.advanceTimersByTime(4000)
    await Promise.resolve()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reportState includes service, node_id, state and health_info', async () => {
    jest.useFakeTimers()
    const client = new DistributedCircuitBreakerClient('http://coordinator.test', 1000)
    const breaker = new CircuitBreaker('svc-state-1')
    client.register(breaker)
    await Promise.resolve()
    fetchMock.mockClear()

    client.startSync()
    jest.advanceTimersByTime(1000)
    await Promise.resolve()

    const stateCall = fetchMock.mock.calls.find(c => String(c[0]).includes('/circuit-breakers/state'))!
    expect(stateCall).toBeTruthy()
    const body = JSON.parse(stateCall[1].body)
    expect(body.service).toBe('svc-state-1')
    expect(body.node_id).toBe('node-123')
    expect(Object.values(CircuitState)).toContain(body.state)
    expect(body.health_info).toBeTruthy()
  })
})

describe('withCircuitBreaker decorator', () => {
  afterEach(() => {
    jest.clearAllMocks()
  })

  it('wraps method and increments breaker metrics on call', async () => {
    const name = 'decor-svc-1'
    class Svc {
      async method(x: number) {
        return x * 2
      }
    }
    const svc = new Svc()
    const descriptor = Object.getOwnPropertyDescriptor(Svc.prototype, 'method')!
    const decorated = withCircuitBreaker(name)
    const newDesc = decorated(Svc.prototype as any, 'method', descriptor)
    Object.defineProperty(Svc.prototype, 'method', newDesc)

    const out = await (svc as any).method(5)
    expect(out).toBe(10)

    const breaker = CircuitBreaker.getOrCreate(name)
    expect(breaker.getHealthInfo().metrics.totalCalls).toBe(1)
    expect(breaker.getHealthInfo().metrics.successfulCalls).toBe(1)
  })

  it('propagates method errors and records failure', async () => {
    const name = 'decor-svc-2'
    class Svc {
      async method() {
        throw new Error('decor-fail')
      }
    }
    const svc = new Svc()
    const descriptor = Object.getOwnPropertyDescriptor(Svc.prototype, 'method')!
    const decorated = withCircuitBreaker(name)
    const newDesc = decorated(Svc.prototype as any, 'method', descriptor)
    Object.defineProperty(Svc.prototype, 'method', newDesc)

    await expect((svc as any).method()).rejects.toThrow('decor-fail')
    const breaker = CircuitBreaker.getOrCreate(name)
    expect(breaker.getHealthInfo().metrics.failedCalls).toBe(1)
  })

  it('decorated method is blocked when breaker is OPEN', async () => {
    const name = 'decor-svc-3'
    class Svc {
      async method() {
        throw new Error('boom')
      }
    }
    const svc = new Svc()
    const descriptor = Object.getOwnPropertyDescriptor(Svc.prototype, 'method')!
    const decorated = withCircuitBreaker(name, { failureThreshold: 1, timeoutMs: 5000 })
    const newDesc = decorated(Svc.prototype as any, 'method', descriptor)
    Object.defineProperty(Svc.prototype, 'method', newDesc)

    await expect((svc as any).method()).rejects.toThrow('boom')
    const breaker = CircuitBreaker.getOrCreate(name)
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    await expect((svc as any).method()).rejects.toBeInstanceOf(CircuitBreakerOpenError)
  })
})