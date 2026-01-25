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
    jest.restoreAllMocks()
    jest.clearAllMocks()
  })

  it('sets name, message and remainingTimeMs correctly', () => {
    const err = new CircuitBreakerOpenError('svc-a', 1234)
    expect(err.name).toBe('CircuitBreakerOpenError')
    expect(err.remainingTimeMs).toBe(1234)
    expect(err.message).toContain("Circuit breaker 'svc-a' is open. Retry after 1234ms")
  })
})

describe('CircuitBreaker - registry', () => {
  afterEach(() => {
    jest.restoreAllMocks()
    jest.clearAllMocks()
  })

  it('getOrCreate returns same instance for same name', () => {
    const a1 = CircuitBreaker.getOrCreate('reg-same-1')
    const a2 = CircuitBreaker.getOrCreate('reg-same-1')
    expect(a1).toBe(a2)
  })

  it('getRegistry returns a copy that does not affect internal registry', () => {
    const original = CircuitBreaker.getOrCreate('reg-copy-1')
    const copy = CircuitBreaker.getRegistry()
    expect(copy.get('reg-copy-1')).toBe(original)
    // Mutate the copy; should not affect actual registry
    copy.set('reg-copy-new', new CircuitBreaker('reg-copy-new'))
    const created = CircuitBreaker.getOrCreate('reg-copy-new')
    // The instance from getOrCreate should not be the one added to the copy map
    expect(copy.get('reg-copy-new')).not.toBe(created)
  })
})

describe('CircuitBreaker - core behavior and metrics', () => {
  let now = 0
  let nowSpy: jest.SpyInstance<number, []>

  beforeEach(() => {
    now = 1_000_000
    nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now)
  })

  afterEach(() => {
    jest.restoreAllMocks()
    jest.clearAllMocks()
  })

  it('starts in CLOSED state', () => {
    const cb = new CircuitBreaker('cb-closed-initial')
    expect(cb.getState()).toBe(CircuitState.CLOSED)
  })

  it('records a successful synchronous call and updates metrics including average response time', () => {
    const cb = new CircuitBreaker('cb-success-1')
    const result = cb.executeSync(() => {
      now += 50
      return 42
    })
    expect(result).toBe(42)
    const health = cb.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(1)
    expect(health.metrics.successfulCalls).toBe(1)
    expect(health.metrics.failedCalls).toBe(0)
    expect(health.metrics.averageResponseTimeMs).toBe(50)
    expect(health.metrics.lastSuccessTime).toBeInstanceOf(Date)
  })

  it('records multiple calls and computes running average response time', () => {
    const cb = new CircuitBreaker('cb-avg-1')

    cb.executeSync(() => {
      now += 20
      return 'ok1'
    })
    cb.executeSync(() => {
      now += 80
      return 'ok2'
    })
    const health = cb.getHealthInfo()
    expect(health.metrics.successfulCalls).toBe(2)
    expect(health.metrics.averageResponseTimeMs).toBe((20 + 80) / 2)
  })

  it('increments failure count and opens after reaching failureThreshold', () => {
    const cb = new CircuitBreaker('cb-open-threshold', {
      failureThreshold: 2,
      timeoutMs: 60_000,
    })

    expect(() => cb.executeSync(() => {
      now += 10
      throw new Error('fail-1')
    })).toThrow('fail-1')
    expect(() => cb.executeSync(() => {
      now += 10
      throw new Error('fail-2')
    })).toThrow('fail-2')

    expect(cb.getState()).toBe(CircuitState.OPEN)
    const health = cb.getHealthInfo()
    expect(health.metrics.failedCalls).toBe(2)
    expect(health.metrics.stateTransitions).toBe(1)
  })

  it('rejects calls when OPEN and uses fallback without throwing', () => {
    const cb = new CircuitBreaker('cb-open-fallback', {
      failureThreshold: 1,
      timeoutMs: 10_000,
    })

    // Open the circuit
    expect(() => cb.executeSync(() => {
      now += 1
      throw new Error('boom')
    })).toThrow('boom')

    const res = cb.executeSync(
      () => {
        now += 1
        return 'should not run'
      },
      () => 'fallback'
    )
    expect(res).toBe('fallback')
    const health = cb.getHealthInfo()
    expect(health.metrics.rejectedCalls).toBe(1)
  })

  it('throws CircuitBreakerOpenError with correct remainingTimeMs when open and no fallback', () => {
    const cb = new CircuitBreaker('cb-open-remaining', {
      failureThreshold: 1,
      timeoutMs: 1000,
    })

    // Open the circuit
    try {
      cb.executeSync(() => {
        now += 1
        throw new Error('open it')
      })
    } catch {}

    // 400ms after opening => remaining 600ms
    now += 400
    try {
      cb.executeSync(() => 'nope')
      throw new Error('should not reach')
    } catch (e: any) {
      expect(e).toBeInstanceOf(CircuitBreakerOpenError)
      expect(e.remainingTimeMs).toBe(600)
      expect(e.message).toContain("Retry after 600ms")
    }
  })

  it('transitions to HALF_OPEN after timeout and then to CLOSED after enough successes', () => {
    const cb = new CircuitBreaker('cb-half-open-close', {
      failureThreshold: 1,
      successThreshold: 2,
      halfOpenMaxCalls: 2,
      timeoutMs: 1000,
    })

    // Open it
    expect(() => cb.executeSync(() => {
      now += 1
      throw new Error('boom')
    })).toThrow('boom')
    expect(cb.getState()).toBe(CircuitState.OPEN)

    // Wait for timeout
    now += 1000
    // First success in HALF_OPEN
    const r1 = cb.executeSync(() => {
      now += 10
      return 'OK1'
    })
    expect(r1).toBe('OK1')
    expect(cb.getState()).toBe(CircuitState.HALF_OPEN)

    // Second success reaches successThreshold -> back to CLOSED
    const r2 = cb.executeSync(() => {
      now += 10
      return 'OK2'
    })
    expect(r2).toBe('OK2')
    expect(cb.getState()).toBe(CircuitState.CLOSED)

    const health = cb.getHealthInfo()
    // Transitions: CLOSED->OPEN (1), OPEN->HALF_OPEN (2), HALF_OPEN->CLOSED (3)
    expect(health.metrics.stateTransitions).toBe(3)
  })

  it('HALF_OPEN limits calls using halfOpenMaxCalls and rejects extra calls', () => {
    const cb = new CircuitBreaker('cb-half-open-limit', {
      failureThreshold: 1,
      successThreshold: 10, // keep it from closing
      halfOpenMaxCalls: 2,
      timeoutMs: 1000,
    })

    // Open it
    expect(() => cb.executeSync(() => {
      now += 1
      throw new Error('boom')
    })).toThrow('boom')
    expect(cb.getState()).toBe(CircuitState.OPEN)

    // Move to HALF_OPEN
    now += 1000

    // Allowed call 1
    expect(cb.executeSync(() => {
      now += 5
      return 'ok1'
    })).toBe('ok1')
    expect(cb.getState()).toBe(CircuitState.HALF_OPEN)

    // Allowed call 2
    expect(cb.executeSync(() => {
      now += 5
      return 'ok2'
    })).toBe('ok2')

    // Third call should be rejected; use fallback
    const val = cb.executeSync(
      () => 'not called',
      () => 'fallback'
    )
    expect(val).toBe('fallback')
    const health = cb.getHealthInfo()
    expect(health.metrics.rejectedCalls).toBe(1)
    expect(cb.getState()).toBe(CircuitState.HALF_OPEN)
  })

  it('HALF_OPEN failure immediately re-opens circuit', () => {
    const cb = new CircuitBreaker('cb-half-open-fail', {
      failureThreshold: 1,
      timeoutMs: 500,
    })

    // Open it
    expect(() => cb.executeSync(() => {
      now += 1
      throw new Error('boom')
    })).toThrow('boom')
    expect(cb.getState()).toBe(CircuitState.OPEN)

    // Move to HALF_OPEN
    now += 500
    // This failure in HALF_OPEN should reopen
    expect(() => cb.executeSync(() => {
      now += 1
      throw new Error('probe fail')
    })).toThrow('probe fail')

    expect(cb.getState()).toBe(CircuitState.OPEN)
    const health = cb.getHealthInfo()
    // Transitions: CLOSED->OPEN (1), OPEN->HALF_OPEN (2), HALF_OPEN->OPEN (3)
    expect(health.metrics.stateTransitions).toBe(3)
  })

  it('opens due to failureRateThreshold even if failure count is below failureThreshold', () => {
    const cb = new CircuitBreaker('cb-open-rate', {
      failureThreshold: 10,
      failureRateThreshold: 0.5,
      slidingWindowSize: 4,
      timeoutMs: 60_000,
    })

    // First failure
    expect(() => cb.executeSync(() => {
      now += 1
      throw new Error('f1')
    })).toThrow('f1')
    expect(cb.getState()).toBe(CircuitState.CLOSED)

    // Second failure makes 2/4 = 0.5 => open
    expect(() => cb.executeSync(() => {
      now += 1
      throw new Error('f2')
    })).toThrow('f2')

    expect(cb.getState()).toBe(CircuitState.OPEN)
  })

  it('calculates failureRate based on sliding window correctly', () => {
    const cb = new CircuitBreaker('cb-rate-calc', {
      slidingWindowSize: 4,
      failureThreshold: 100,
      failureRateThreshold: 1, // prevent opening due to rate
      timeoutMs: 60_000,
    })

    // Make pattern: F, F, S, F => 3 failures out of 4 => 0.75
    try { cb.executeSync(() => { now += 1; throw new Error('f1') }) } catch {}
    try { cb.executeSync(() => { now += 1; throw new Error('f2') }) } catch {}
    cb.executeSync(() => { now += 1; return 's1' })
    try { cb.executeSync(() => { now += 1; throw new Error('f3') }) } catch {}

    const health = cb.getHealthInfo()
    expect(health.failureRate).toBeCloseTo(0.75, 5)
    expect(health.state).toBe(CircuitState.CLOSED)
  })
})

describe('DistributedCircuitBreakerClient', () => {
  let fetchMock: jest.Mock

  beforeEach(() => {
    fetchMock = jest.fn()
    ;(global as any).fetch = fetchMock
  })

  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
    jest.clearAllMocks()
    delete (global as any).fetch
  })

  it('register() posts registration with proper payload', async () => {
    process.env.NODE_ID = 'node-1'
    fetchMock.mockResolvedValue({ ok: true })

    const cb = new CircuitBreaker('svc-register', {
      failureThreshold: 7,
      successThreshold: 2,
    })
    const client = new DistributedCircuitBreakerClient('http://coord')
    client.register(cb)

    // wait microtask queue flush
    await Promise.resolve()

    expect(fetchMock).toHaveBeenCalledWith('http://coord/circuit-breakers/register', expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: expect.any(String),
    }))
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.service).toBe('svc-register')
    expect(body.node_id).toBe('node-1')
    expect(body.failure_threshold).toBe(7)
    expect(body.success_threshold).toBe(2)
  })

  it('getAggregatedState returns parsed data on success', async () => {
    const data = {
      service: 'svc-a',
      consensusState: CircuitState.HALF_OPEN,
      totalNodes: 3,
      healthScore: 0.8,
      nodeStates: { a: CircuitState.OPEN },
    }
    fetchMock.mockResolvedValue({
      json: async () => data,
    })

    const client = new DistributedCircuitBreakerClient('http://coord')
    const res = await client.getAggregatedState('svc-a')
    expect(res).toEqual(data)
  })

  it('getAggregatedState returns defaults on fetch failure', async () => {
    fetchMock.mockRejectedValue(new Error('network'))

    const client = new DistributedCircuitBreakerClient('http://coord')
    const res = await client.getAggregatedState('svc-b')
    expect(res.service).toBe('svc-b')
    expect(res.consensusState).toBe(CircuitState.CLOSED)
    expect(res.totalNodes).toBe(0)
    expect(res.healthScore).toBe(0)
    expect(res.nodeStates).toEqual({})
  })

  it('startSync periodically posts states for registered breakers and stopSync stops it', async () => {
    jest.useFakeTimers()
    process.env.NODE_ID = 'node-2'
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) })

    const cb1 = new CircuitBreaker('svc-sync-1')
    const cb2 = new CircuitBreaker('svc-sync-2')
    const client = new DistributedCircuitBreakerClient('http://coord', 100)

    client.register(cb1)
    client.register(cb2)

    // wait for registration posts to resolve
    await Promise.resolve()
    // Clear mock calls to only capture state sync calls
    fetchMock.mockClear()

    client.startSync()

    // Advance enough for one sync tick
    await Promise.resolve()
    jest.advanceTimersByTime(110)

    // Two posts for states (one per breaker)
    const postCalls = fetchMock.mock.calls.filter(
      (c) => typeof c[0] === 'string' && (c[0] as string).endsWith('/circuit-breakers/state')
    )
    expect(postCalls.length).toBeGreaterThanOrEqual(2)
    const body1 = JSON.parse(postCalls[0][1].body)
    expect(body1.service).toMatch(/svc-sync-/)
    expect([CircuitState.CLOSED, CircuitState.OPEN, CircuitState.HALF_OPEN]).toContain(body1.state)
    expect(typeof body1.timestamp).toBe('number')
    expect(body1.health_info).toBeDefined()

    client.stopSync()
    fetchMock.mockClear()
    jest.advanceTimersByTime(300)
    // No more sync posts after stop
    const morePosts = fetchMock.mock.calls.filter(
      (c) => typeof c[0] === 'string' && (c[0] as string).endsWith('/circuit-breakers/state')
    )
    expect(morePosts.length).toBe(0)
  })
})

describe('withCircuitBreaker decorator', () => {
  let now = 0
  let nowSpy: jest.SpyInstance<number, []>

  beforeEach(() => {
    now = 10_000
    nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now)
  })

  afterEach(() => {
    jest.restoreAllMocks()
    jest.clearAllMocks()
  })

  it('wraps method and executes successfully via circuit breaker', async () => {
    class Service {
      async plusOne(n: number) {
        now += 10
        return n + 1
      }
    }
    const descriptor = Object.getOwnPropertyDescriptor(Service.prototype, 'plusOne')!
    const dec = withCircuitBreaker('decorator-success-' + Math.random())
    const newDesc = dec(Service.prototype as any, 'plusOne', descriptor) as PropertyDescriptor
    Object.defineProperty(Service.prototype, 'plusOne', newDesc)

    const svc = new Service()
    const val = await svc.plusOne(4)
    expect(val).toBe(5)
  })

  it('propagates errors and opens circuit when failures reach threshold', async () => {
    class Service {
      async risky(n: number) {
        now += 5
        throw new Error('bad op')
      }
    }
    const name = 'decorator-open-' + Math.random()
    const descriptor = Object.getOwnPropertyDescriptor(Service.prototype, 'risky')!
    const dec = withCircuitBreaker(name, { failureThreshold: 1, timeoutMs: 10_000 })
    const newDesc = dec(Service.prototype as any, 'risky', descriptor) as PropertyDescriptor
    Object.defineProperty(Service.prototype, 'risky', newDesc)

    const svc = new Service()
    await expect(svc.risky(1)).rejects.toThrow('bad op')

    // Second call should be rejected by open circuit
    await expect(svc.risky(2)).rejects.toBeInstanceOf(CircuitBreakerOpenError)

    // Verify breaker state is open
    const breaker = CircuitBreaker.getOrCreate(name)
    expect(breaker.getState()).toBe(CircuitState.OPEN)
  })
})