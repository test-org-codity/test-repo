import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals'
import {
  CircuitBreaker,
  CircuitBreakerOpenError,
  CircuitState,
  DistributedCircuitBreakerClient,
  withCircuitBreaker,
} from '../src/circuit-breaker'

const setGlobalFetch = () => {
  ;(global as any).fetch = jest.fn()
}

const clearGlobalFetch = () => {
  ;(global as any).fetch = undefined
}

const uniqueName = (prefix = 'svc') => `${prefix}-${Math.random().toString(36).slice(2)}`

afterEach(() => {
  jest.clearAllMocks()
  jest.useRealTimers()
  clearGlobalFetch()
})

describe('CircuitBreakerOpenError', () => {
  it('sets error name and message with rounded remaining time', () => {
    const err = new CircuitBreakerOpenError('payment', 1234.6)
    expect(err.name).toBe('CircuitBreakerOpenError')
    expect(err.message).toContain("Circuit breaker 'payment' is open. Retry after 1235ms")
    expect((err as any).remainingTimeMs).toBe(1234.6)
  })
})

describe('CircuitBreaker basics', () => {
  it('getOrCreate returns same instance for same name', () => {
    const name = uniqueName('registry')
    const a = CircuitBreaker.getOrCreate(name)
    const b = CircuitBreaker.getOrCreate(name)
    expect(a).toBe(b)
  })

  it('getRegistry returns a copy that does not mutate original registry', () => {
    const name = uniqueName('registry-copy')
    CircuitBreaker.getOrCreate(name)
    const copy = CircuitBreaker.getRegistry()
    copy.set('new-one', new CircuitBreaker('new-one'))
    const copy2 = CircuitBreaker.getRegistry()
    expect(copy2.has('new-one')).toBe(false)
    expect(copy2.has(name)).toBe(true)
  })
})

describe('CircuitBreaker execution and metrics', () => {
  it('successful executeSync increments metrics and decreases failureCount', () => {
    const name = uniqueName('success')
    const breaker = new CircuitBreaker(name, { failureThreshold: 10 })
    // First, cause one failure to set failureCount = 1
    expect(() => breaker.executeSync(() => { throw new Error('fail') })).toThrow('fail')
    const before = breaker.getHealthInfo()
    expect(before.failureCount).toBe(1)
    const result = breaker.executeSync(() => 42)
    expect(result).toBe(42)
    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(1) // only successful call counted in totalCalls
    expect(health.metrics.successfulCalls).toBe(1)
    expect(health.metrics.failedCalls).toBe(1)
    expect(health.metrics.lastSuccessTime).toBeInstanceOf(Date)
    expect(health.failureCount).toBe(0) // decreased from 1 to 0
  })

  it('opens after reaching failureThreshold and then rejects', () => {
    const name = uniqueName('threshold')
    const breaker = new CircuitBreaker(name, {
      failureThreshold: 2,
      failureRateThreshold: 1, // avoid rate triggering earlier
      timeoutMs: 10000,
    })
    // two failures cause OPEN
    expect(() => breaker.executeSync(() => { throw new Error('e1') })).toThrow('e1')
    expect(() => breaker.executeSync(() => { throw new Error('e2') })).toThrow('e2')
    expect(breaker.getState()).toBe(CircuitState.OPEN)
    // next call should be rejected with CircuitBreakerOpenError
    try {
      breaker.executeSync(() => 1)
      throw new Error('should not reach')
    } catch (err) {
      expect(err).toBeInstanceOf(CircuitBreakerOpenError)
      const e = err as CircuitBreakerOpenError
      expect(e.message).toContain(`Circuit breaker '${name}' is open.`)
      expect(e.remainingTimeMs).toBeGreaterThanOrEqual(0)
      expect(e.remainingTimeMs).toBeLessThanOrEqual(10000)
    }
    const health = breaker.getHealthInfo()
    expect(health.metrics.rejectedCalls).toBe(1)
    expect(health.metrics.totalCalls).toBe(2) // only the 2 allowed calls counted
  })

  it('opens due to failureRateThreshold in sliding window', () => {
    const name = uniqueName('rate')
    const breaker = new CircuitBreaker(name, {
      failureThreshold: 100, // high to avoid threshold-based open
      failureRateThreshold: 0.5,
      slidingWindowSize: 4,
      timeoutMs: 10000,
    })
    expect(() => breaker.executeSync(() => { throw new Error('f1') })).toThrow()
    expect(breaker.getState()).toBe(CircuitState.CLOSED)
    expect(() => breaker.executeSync(() => { throw new Error('f2') })).toThrow()
    // Now 2 failures out of window of 4 => rate = 0.5 => opens
    expect(breaker.getState()).toBe(CircuitState.OPEN)
  })

  it('fallback is used when circuit is open and request is not allowed', async () => {
    const name = uniqueName('fallback')
    const breaker = new CircuitBreaker(name, {
      failureThreshold: 1,
      timeoutMs: 5000,
    })
    await expect(breaker.execute(async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(breaker.getState()).toBe(CircuitState.OPEN)
    const value = await breaker.execute(async () => 1, async () => 99)
    expect(value).toBe(99)
    const health = breaker.getHealthInfo()
    expect(health.metrics.rejectedCalls).toBe(1)
    // ensure totalCalls did not increase for the rejected one
    expect(health.metrics.totalCalls).toBe(1)
  })

  it('does not use fallback on operation failure while allowed (CLOSED)', () => {
    const name = uniqueName('no-fallback-on-failure')
    const breaker = new CircuitBreaker(name, { failureThreshold: 10 })
    const fallback = jest.fn(() => 123)
    expect(() => breaker.executeSync(() => { throw new Error('op-fail') }, fallback)).toThrow('op-fail')
    expect(fallback).not.toHaveBeenCalled()
    const health = breaker.getHealthInfo()
    expect(health.metrics.failedCalls).toBe(1)
    expect(health.metrics.totalCalls).toBe(1)
  })

  it('transitions OPEN -> HALF_OPEN after timeout and limits half-open calls', () => {
    jest.useFakeTimers()
    const name = uniqueName('half-open')
    const breaker = new CircuitBreaker(name, {
      failureThreshold: 1,
      timeoutMs: 1000,
      halfOpenMaxCalls: 2,
    })
    // Open it
    expect(() => breaker.executeSync(() => { throw new Error('f') })).toThrow()
    expect(breaker.getState()).toBe(CircuitState.OPEN)
    // advance time to allow HALF_OPEN
    jest.advanceTimersByTime(1001)
    // First two calls allowed (half-open), third rejected
    const r1 = breaker.executeSync(() => 'ok1')
    const r2 = breaker.executeSync(() => 'ok2')
    expect(r1).toBe('ok1')
    expect(r2).toBe('ok2')
    // Third call should be rejected without fallback
    expect(() => breaker.executeSync(() => 'ok3')).toThrow(CircuitBreakerOpenError)
    const health = breaker.getHealthInfo()
    expect(health.state).toBe(CircuitState.HALF_OPEN)
    expect(health.metrics.rejectedCalls).toBe(1)
  })

  it('in HALF_OPEN, a failure re-opens immediately', () => {
    jest.useFakeTimers()
    const name = uniqueName('half-open-fail')
    const breaker = new CircuitBreaker(name, {
      failureThreshold: 1,
      timeoutMs: 1000,
      halfOpenMaxCalls: 3,
    })
    // Open
    expect(() => breaker.executeSync(() => { throw new Error('fail') })).toThrow()
    expect(breaker.getState()).toBe(CircuitState.OPEN)
    // Allow HALF_OPEN
    jest.advanceTimersByTime(1100)
    // First half-open trial fails -> back to OPEN
    expect(() => breaker.executeSync(() => { throw new Error('trial-fail') })).toThrow('trial-fail')
    expect(breaker.getState()).toBe(CircuitState.OPEN)
    // While still within timeout, next call is rejected
    expect(() => breaker.executeSync(() => 1)).toThrow(CircuitBreakerOpenError)
  })

  it('in HALF_OPEN, reaching successThreshold transitions to CLOSED and resets failure rate', () => {
    jest.useFakeTimers()
    const name = uniqueName('half-open-success')
    const breaker = new CircuitBreaker(name, {
      failureThreshold: 1,
      successThreshold: 2,
      timeoutMs: 1000,
      slidingWindowSize: 4,
    })
    // Get some failures first (open)
    expect(() => breaker.executeSync(() => { throw new Error('f') })).toThrow()
    expect(breaker.getState()).toBe(CircuitState.OPEN)
    // Move to HALF_OPEN and do two successes
    jest.advanceTimersByTime(1005)
    breaker.executeSync(() => 'a')
    breaker.executeSync(() => 'b')
    expect(breaker.getState()).toBe(CircuitState.CLOSED)
    const health = breaker.getHealthInfo()
    expect(health.failureRate).toBe(0) // sliding window reset on close
    expect(health.failureCount).toBe(0)
  })

  it('averageResponseTimeMs computes rolling average and caps at 100 entries', () => {
    const name = uniqueName('avg')
    const breaker = new CircuitBreaker(name, { failureThreshold: 1000 })
    // Mock Date.now to control durations
    const seq: number[] = []
    // We will make 101 calls; for each call, Date.now called twice: start and end
    // For call i (1..101), we want duration i (ms)
    let current = 0
    for (let i = 1; i <= 101; i++) {
      seq.push(current)
      current += i
      seq.push(current)
    }
    let idx = 0
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => seq[idx++])
    for (let i = 1; i <= 101; i++) {
      breaker.executeSync(() => 'x')
    }
    nowSpy.mockRestore()
    const health = breaker.getHealthInfo()
    // Rolling window keeps last 100 durations: 2..101
    // Average of 2..101 = (2+101)/2 = 51.5
    expect(Math.abs(health.metrics.averageResponseTimeMs - 51.5)).toBeLessThan(1e-9)
    expect(health.metrics.successfulCalls).toBe(101)
  })
})

describe('DistributedCircuitBreakerClient', () => {
  it('getAggregatedState returns server JSON on success', async () => {
    setGlobalFetch()
    const agg = {
      service: 'svc',
      consensusState: CircuitState.OPEN,
      totalNodes: 3,
      healthScore: 0.8,
      nodeStates: { a: CircuitState.OPEN, b: CircuitState.CLOSED },
    }
    ;(global as any).fetch.mockResolvedValue({
      json: jest.fn().mockResolvedValue(agg),
    })
    const client = new DistributedCircuitBreakerClient('http://coord')
    const res = await client.getAggregatedState('svc')
    expect(res).toEqual(agg)
    expect((global as any).fetch).toHaveBeenCalledWith('http://coord/circuit-breakers/svc/aggregate')
  })

  it('getAggregatedState returns defaults on fetch error', async () => {
    setGlobalFetch()
    ;(global as any).fetch.mockRejectedValue(new Error('network'))
    const client = new DistributedCircuitBreakerClient('http://coord')
    const res = await client.getAggregatedState('svc-x')
    expect(res.service).toBe('svc-x')
    expect(res.consensusState).toBe(CircuitState.CLOSED)
    expect(res.totalNodes).toBe(0)
    expect(res.nodeStates).toEqual({})
  })

  it('register sends registration payload with thresholds', async () => {
    setGlobalFetch()
    const envBefore = process.env.NODE_ID
    process.env.NODE_ID = 'node-123'
    ;(global as any).fetch.mockResolvedValue({ json: jest.fn() })
    const breaker = new CircuitBreaker(uniqueName('register'), {
      failureThreshold: 7,
      successThreshold: 4,
    })
    const client = new DistributedCircuitBreakerClient('http://coord')
    client.register(breaker)
    await Promise.resolve()
    expect((global as any).fetch).toHaveBeenCalledTimes(1)
    const [url, init] = (global as any).fetch.mock.calls[0]
    expect(url).toBe('http://coord/circuit-breakers/register')
    const body = JSON.parse(init.body)
    expect(body.service).toBe(breaker.name)
    expect(body.node_id).toBe('node-123')
    expect(body.failure_threshold).toBe(7)
    expect(body.success_threshold).toBe(4)
    process.env.NODE_ID = envBefore
  })

  it('startSync posts state periodically and stopSync stops it', async () => {
    jest.useFakeTimers()
    setGlobalFetch()
    ;(global as any).fetch.mockResolvedValue({ json: jest.fn() })
    const client = new DistributedCircuitBreakerClient('http://coord', 200)
    const breaker = new CircuitBreaker(uniqueName('sync'))
    client.register(breaker)
    await Promise.resolve()
    ;(global as any).fetch.mockClear()
    client.startSync()
    jest.advanceTimersByTime(210)
    await Promise.resolve()
    expect((global as any).fetch).toHaveBeenCalled()
    const [url1, init1] = (global as any).fetch.mock.calls[0]
    expect(url1).toBe('http://coord/circuit-breakers/state')
    const payload1 = JSON.parse(init1.body)
    expect(payload1.service).toBe(breaker.name)
    expect(payload1.state).toBe(CircuitState.CLOSED)
    ;(global as any).fetch.mockClear()
    client.stopSync()
    jest.advanceTimersByTime(600)
    await Promise.resolve()
    expect((global as any).fetch).not.toHaveBeenCalled()
  })
})

describe('withCircuitBreaker decorator', () => {
  it('wraps method and opens breaker after failures then short-circuits', async () => {
    const name = uniqueName('decorator')
    class Svc {
      @withCircuitBreaker(name, { failureThreshold: 2, timeoutMs: 100000 })
      async action(flag: number): Promise<string> {
        if (flag < 0) throw new Error('bad')
        return `ok-${flag}`
      }
    }
    const svc = new Svc()
    await expect(svc.action(-1)).rejects.toThrow('bad')
    await expect(svc.action(-2)).rejects.toThrow('bad')
    const registryBreaker = CircuitBreaker.getOrCreate(name)
    expect(registryBreaker.getState()).toBe(CircuitState.OPEN)
    await expect(svc.action(1)).rejects.toBeInstanceOf(CircuitBreakerOpenError)
  })

  it('decorated method returns result on success', async () => {
    const name = uniqueName('decorator-ok')
    class Svc2 {
      calls = 0
      @withCircuitBreaker(name)
      async run(x: number): Promise<number> {
        this.calls++
        return x * 2
      }
    }
    const svc = new Svc2()
    const res = await svc.run(5)
    expect(res).toBe(10)
    const br = CircuitBreaker.getOrCreate(name)
    const health = br.getHealthInfo()
    expect(health.metrics.successfulCalls).toBe(1)
    expect(svc.calls).toBe(1)
  })
})

describe('execute (async) timing and averageResponseTimeMs', () => {
  it('computes average using async execute durations', async () => {
    const name = uniqueName('avg-async')
    const breaker = new CircuitBreaker(name, { failureThreshold: 10 })
    const seq: number[] = []
    // 3 calls: durations 10, 30, 60
    // We need 2 Date.now per execute = 6 calls
    const starts = [0, 100, 300]
    const ends = [10, 130, 360]
    for (let i = 0; i < 3; i++) {
      seq.push(starts[i], ends[i])
    }
    let idx = 0
    const spy = jest.spyOn(Date, 'now').mockImplementation(() => seq[idx++])
    const op = async (ms: number) => 'done' as const
    await breaker.execute(() => op(10))
    await breaker.execute(() => op(30))
    await breaker.execute(() => op(60))
    spy.mockRestore()
    const avg = breaker.getHealthInfo().metrics.averageResponseTimeMs
    expect(avg).toBeCloseTo((10 + 30 + 60) / 3, 10)
  })
})