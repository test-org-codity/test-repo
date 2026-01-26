import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals'
import { CircuitBreaker, CircuitBreakerOpenError, CircuitState, DistributedCircuitBreakerClient, withCircuitBreaker } from '../src/circuit-breaker'

describe('CircuitBreaker basic behavior', () => {
  afterEach(() => {
    jest.clearAllMocks()
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  it('execute resolves and records success metrics', async () => {
    const cb = new CircuitBreaker('svc-success', { failureThreshold: 2 })
    const result = await cb.execute(async () => 'ok')
    expect(result).toBe('ok')
    const health = cb.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(1)
    expect(health.metrics.successfulCalls).toBe(1)
    expect(health.metrics.failedCalls).toBe(0)
    expect(health.metrics.lastSuccessTime).toBeInstanceOf(Date)
    expect(health.state).toBe(CircuitState.CLOSED)
  })

  it('execute rejects and records failure metrics; opens when threshold reached', async () => {
    const cb = new CircuitBreaker('svc-fail', { failureThreshold: 2, failureRateThreshold: 1 })
    await expect(cb.execute(async () => { throw new Error('boom1') })).rejects.toThrow('boom1')
    let health = cb.getHealthInfo()
    expect(health.metrics.failedCalls).toBe(1)
    expect(health.state).toBe(CircuitState.CLOSED)

    await expect(cb.execute(async () => { throw new Error('boom2') })).rejects.toThrow('boom2')
    health = cb.getHealthInfo()
    expect(health.metrics.failedCalls).toBe(2)
    expect(health.state).toBe(CircuitState.OPEN)
    expect(health.metrics.stateTransitions).toBeGreaterThanOrEqual(1)
    expect(health.metrics.lastFailureTime).toBeInstanceOf(Date)
  })

  it('throws CircuitBreakerOpenError when open and no fallback; increments rejectedCalls', async () => {
    const cb = new CircuitBreaker('svc-open-no-fallback', { failureThreshold: 1, timeoutMs: 1000 })
    await expect(cb.execute(async () => { throw new Error('err') })).rejects.toThrow('err')
    const before = cb.getHealthInfo().metrics.rejectedCalls
    await expect(cb.execute(async () => 'ok')).rejects.toBeInstanceOf(CircuitBreakerOpenError)
    const after = cb.getHealthInfo().metrics.rejectedCalls
    expect(after).toBe(before + 1)
    try {
      await cb.execute(async () => 'ok')
    } catch (e: any) {
      expect(e).toBeInstanceOf(CircuitBreakerOpenError)
      expect(e.name).toBe('CircuitBreakerOpenError')
      expect(typeof e.remainingTimeMs).toBe('number')
      expect(e.message).toContain("Circuit breaker 'svc-open-no-fallback' is open. Retry after")
    }
  })

  it('uses fallback when open and records rejected call', async () => {
    const cb = new CircuitBreaker('svc-open-fallback', { failureThreshold: 1, timeoutMs: 1000 })
    await expect(cb.execute(async () => { throw new Error('err') })).rejects.toThrow('err')
    const res = await cb.execute(async () => 'should-not-run', async () => 'fallback-value')
    expect(res).toBe('fallback-value')
    const health = cb.getHealthInfo()
    expect(health.metrics.rejectedCalls).toBe(1)
  })

  it('does not call fallback on operation failure (only when breaker is open)', async () => {
    const cb = new CircuitBreaker('svc-fallback-not-used', { failureThreshold: 10 })
    const fallback = jest.fn(async () => 'fallback')
    await expect(cb.execute(async () => { throw new Error('err') }, fallback)).rejects.toThrow('err')
    expect(fallback).not.toHaveBeenCalled()
  })

  it('executeSync returns value and records success', () => {
    const cb = new CircuitBreaker('svc-exec-sync', {})
    const result = cb.executeSync(() => 42)
    expect(result).toBe(42)
    const health = cb.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(1)
    expect(health.metrics.successfulCalls).toBe(1)
    expect(health.metrics.failedCalls).toBe(0)
  })

  it('executeSync throws and records failure, opens when threshold reached', () => {
    const cb = new CircuitBreaker('svc-exec-sync-fail', { failureThreshold: 1 })
    expect(() => cb.executeSync(() => { throw new Error('nope') })).toThrow('nope')
    const health = cb.getHealthInfo()
    expect(health.state).toBe(CircuitState.OPEN)
    expect(health.metrics.failedCalls).toBe(1)
  })
})

describe('CircuitBreaker half-open behavior', () => {
  afterEach(() => {
    jest.clearAllMocks()
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  it('transitions to HALF_OPEN after timeout and limits calls with halfOpenMaxCalls', async () => {
    let now = 1000
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now)

    const cb = new CircuitBreaker('svc-half-open-limit', {
      failureThreshold: 1,
      timeoutMs: 500,
      halfOpenMaxCalls: 1,
      successThreshold: 999
    })

    await expect(cb.execute(async () => { throw new Error('fail') })).rejects.toThrow()
    expect(cb.getState()).toBe(CircuitState.OPEN)

    now = 1600 // exceed timeout
    expect(cb.getState()).toBe(CircuitState.HALF_OPEN)

    // First call allowed
    const res1 = await cb.execute(async () => 'ok1')
    expect(res1).toBe('ok1')

    // Second call should be rejected due to halfOpenMaxCalls limit
    const rejectedBefore = cb.getHealthInfo().metrics.rejectedCalls
    await expect(cb.execute(async () => 'ok2')).rejects.toBeInstanceOf(CircuitBreakerOpenError)
    const rejectedAfter = cb.getHealthInfo().metrics.rejectedCalls
    expect(rejectedAfter).toBe(rejectedBefore + 1)

    nowSpy.mockRestore()
  })

  it('in HALF_OPEN, consecutive successes >= successThreshold transitions to CLOSED and resets counts', async () => {
    let now = 1000
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now)

    const cb = new CircuitBreaker('svc-half-open-close', {
      failureThreshold: 1,
      timeoutMs: 500,
      halfOpenMaxCalls: 5,
      successThreshold: 2
    })

    await expect(cb.execute(async () => { throw new Error('boom') })).rejects.toThrow()
    expect(cb.getState()).toBe(CircuitState.OPEN)

    now = 1600
    expect(cb.getState()).toBe(CircuitState.HALF_OPEN)

    await cb.execute(async () => 'ok')
    expect(cb.getState()).toBe(CircuitState.HALF_OPEN)
    await cb.execute(async () => 'ok2')
    expect(cb.getState()).toBe(CircuitState.CLOSED)

    const health = cb.getHealthInfo()
    expect(health.failureCount).toBe(0)
    expect(health.successCount).toBe(0)
    expect(health.metrics.stateTransitions).toBeGreaterThanOrEqual(2)
    nowSpy.mockRestore()
  })

  it('in HALF_OPEN, any failure transitions back to OPEN', async () => {
    let now = 1000
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now)

    const cb = new CircuitBreaker('svc-half-open-failure', {
      failureThreshold: 1,
      timeoutMs: 500,
      halfOpenMaxCalls: 5,
      successThreshold: 3
    })

    await expect(cb.execute(async () => { throw new Error('fail') })).rejects.toThrow()
    expect(cb.getState()).toBe(CircuitState.OPEN)

    now = 1600
    expect(cb.getState()).toBe(CircuitState.HALF_OPEN)

    await expect(cb.execute(async () => { throw new Error('again') })).rejects.toThrow('again')
    expect(cb.getState()).toBe(CircuitState.OPEN)
    nowSpy.mockRestore()
  })

  it('remains OPEN if timeout not reached', async () => {
    let now = 1000
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now)

    const cb = new CircuitBreaker('svc-still-open', {
      failureThreshold: 1,
      timeoutMs: 1000
    })
    await expect(cb.execute(async () => { throw new Error('fail') })).rejects.toThrow()
    expect(cb.getState()).toBe(CircuitState.OPEN)

    now = 1500 // not enough time
    expect(cb.getState()).toBe(CircuitState.OPEN)
    nowSpy.mockRestore()
  })
})

describe('CircuitBreaker sliding window and metrics', () => {
  afterEach(() => {
    jest.clearAllMocks()
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  it('opens based on failure rate threshold using sliding window', async () => {
    const cb = new CircuitBreaker('svc-failure-rate', {
      failureThreshold: 100, // ensure count threshold not reached
      slidingWindowSize: 4,
      failureRateThreshold: 0.5
    })

    // First two failures should fill 2/4 = 0.5 and open
    await expect(cb.execute(async () => { throw new Error('f1') })).rejects.toThrow('f1')
    let health = cb.getHealthInfo()
    expect(health.state).toBe(CircuitState.CLOSED)

    await expect(cb.execute(async () => { throw new Error('f2') })).rejects.toThrow('f2')
    health = cb.getHealthInfo()
    expect(health.state).toBe(CircuitState.OPEN)
  })

  it('averageResponseTimeMs computed and trims to last 100 samples', () => {
    const cb = new CircuitBreaker('svc-avg-rt')

    const spy = jest.spyOn(Date, 'now')
    let call = 0
    spy.mockImplementation(() => {
      call += 1
      // odd calls: start=0, even calls: duration increases by 1 each time
      return call % 2 === 1 ? 0 : call / 2
    })

    for (let i = 0; i < 101; i++) {
      cb.executeSync(() => true)
    }
    const avg = cb.getHealthInfo().metrics.averageResponseTimeMs
    expect(avg).toBeCloseTo(51.5, 5) // average of 2..101
    spy.mockRestore()
  })
})

describe('CircuitBreaker registry', () => {
  afterEach(() => {
    jest.clearAllMocks()
  })

  it('getOrCreate returns same instance for same name', () => {
    const a = CircuitBreaker.getOrCreate('shared', { failureThreshold: 3 })
    const b = CircuitBreaker.getOrCreate('shared', { failureThreshold: 10 })
    expect(a).toBe(b)
  })

  it('getRegistry returns a copy of registry map', () => {
    const name1 = 'reg-1'
    const name2 = 'reg-2'
    CircuitBreaker.getOrCreate(name1)
    CircuitBreaker.getOrCreate(name2)
    const regCopy = CircuitBreaker.getRegistry()
    expect(regCopy).toBeInstanceOf(Map)
    expect(regCopy.size).toBeGreaterThanOrEqual(2)
    // Mutating the copy should not change the original registry
    regCopy.set('new', new CircuitBreaker('new'))
    const regCopy2 = CircuitBreaker.getRegistry()
    expect(regCopy2.has('new')).toBe(false)
  })
})

describe('withCircuitBreaker decorator', () => {
  afterEach(() => {
    jest.clearAllMocks()
    jest.restoreAllMocks()
  })

  it('wraps method and uses CircuitBreaker.execute', async () => {
    const executeMock = jest.fn().mockResolvedValue('wrapped-result')
    const getOrCreateSpy = jest.spyOn(CircuitBreaker, 'getOrCreate').mockReturnValue({
      name: 'decorated',
      execute: executeMock,
    } as unknown as CircuitBreaker)

    class Svc {
      async originalMethod(a: number, b: number) {
        return a + b
      }
    }

    const decorator = withCircuitBreaker('decorated')
    const proto = Svc.prototype as any
    const desc = Object.getOwnPropertyDescriptor(proto, 'originalMethod')!
    const newDesc = decorator(proto, 'originalMethod', desc)
    if (newDesc) {
      Object.defineProperty(proto, 'originalMethod', newDesc)
    }
    const instance = new Svc()
    const res = await (instance as any).originalMethod(1, 2)
    expect(res).toBe('wrapped-result')
    expect(getOrCreateSpy).toHaveBeenCalledWith('decorated', undefined)
    expect(executeMock).toHaveBeenCalled()
  })
})

describe('DistributedCircuitBreakerClient', () => {
  let originalFetch: any
  let originalNodeId: string | undefined

  beforeEach(() => {
    originalFetch = (global as any).fetch
    ;(global as any).fetch = jest.fn()
    originalNodeId = process.env.NODE_ID
    process.env.NODE_ID = 'node-1'
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.clearAllMocks()
    jest.useRealTimers()
    ;(global as any).fetch = originalFetch
    process.env.NODE_ID = originalNodeId
  })

  it('register sends registration to coordinator with node ID', async () => {
    const fetchMock = (global as any).fetch as jest.Mock
    fetchMock.mockResolvedValue({ ok: true })
    const client = new DistributedCircuitBreakerClient('http://coordinator', 1000)
    const breaker = new CircuitBreaker('svc-register', { failureThreshold: 7, successThreshold: 2 })
    client.register(breaker)

    // allow async sendRegistration to run
    await Promise.resolve()
    expect(fetchMock).toHaveBeenCalled()
    const [url, options] = fetchMock.mock.calls[0]
    expect(url).toBe('http://coordinator/circuit-breakers/register')
    expect(options.method).toBe('POST')
    const body = JSON.parse(options.body)
    expect(body).toMatchObject({
      service: 'svc-register',
      node_id: 'node-1',
      failure_threshold: 7,
      success_threshold: 2
    })
  })

  it('startSync periodically reports state and stopSync stops it', async () => {
    const fetchMock = (global as any).fetch as jest.Mock
    fetchMock.mockResolvedValue({ ok: true })
    const client = new DistributedCircuitBreakerClient('http://coordinator', 200)
    const breaker = new CircuitBreaker('svc-sync', {})
    client.register(breaker)

    client.startSync()
    // tick once
    jest.advanceTimersByTime(210)
    await Promise.resolve()
    // One call for registration + one for reporting state
    expect(fetchMock).toHaveBeenCalled()
    const stateCall = fetchMock.mock.calls.find((c: any) => (c[0] as string).endsWith('/circuit-breakers/state'))
    expect(stateCall).toBeTruthy()
    const [, stateOptions] = stateCall!
    const payload = JSON.parse(stateOptions.body)
    expect(payload).toMatchObject({
      service: 'svc-sync',
      node_id: 'node-1',
      state: breaker.getState()
    })
    expect(typeof payload.timestamp).toBe('number')
    expect(payload.health_info.name).toBe('svc-sync')

    const callsBeforeStop = fetchMock.mock.calls.length
    client.stopSync()
    jest.advanceTimersByTime(500)
    await Promise.resolve()
    expect(fetchMock.mock.calls.length).toBe(callsBeforeStop)
  })

  it('getAggregatedState returns parsed data on success', async () => {
    const fetchMock = (global as any).fetch as jest.Mock
    const data = {
      service: 'svc-agg',
      consensusState: CircuitState.CLOSED,
      totalNodes: 3,
      healthScore: 0.9,
      nodeStates: { a: CircuitState.CLOSED, b: CircuitState.OPEN, c: CircuitState.CLOSED }
    }
    fetchMock.mockResolvedValue({ json: async () => data })
    const client = new DistributedCircuitBreakerClient('http://coordinator')
    const res = await client.getAggregatedState('svc-agg')
    expect(res).toEqual(data)
  })

  it('getAggregatedState returns default on error', async () => {
    const fetchMock = (global as any).fetch as jest.Mock
    fetchMock.mockRejectedValue(new Error('network'))
    const client = new DistributedCircuitBreakerClient('http://coordinator')
    const res = await client.getAggregatedState('svc-default')
    expect(res).toEqual({
      service: 'svc-default',
      consensusState: CircuitState.CLOSED,
      totalNodes: 0,
      healthScore: 0,
      nodeStates: {}
    })
  })
})