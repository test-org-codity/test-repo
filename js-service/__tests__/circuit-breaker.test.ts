import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals'
import {
  CircuitBreaker,
  CircuitBreakerOpenError,
  CircuitState,
  DistributedCircuitBreakerClient,
  withCircuitBreaker,
} from '../src/circuit-breaker'

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

describe('CircuitBreakerOpenError', () => {
  afterEach(() => {
    jest.clearAllMocks()
    jest.restoreAllMocks()
  })

  it('formats message and sets name correctly', () => {
    const err = new CircuitBreakerOpenError('payments', 123.4)
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('CircuitBreakerOpenError')
    expect(err.remainingTimeMs).toBe(123.4)
    expect(err.message).toContain("Circuit breaker 'payments' is open")
    expect(err.message).toContain('Retry after 123ms')
  })
})

describe('CircuitBreaker basic behavior', () => {
  afterEach(() => {
    jest.clearAllMocks()
    jest.restoreAllMocks()
    jest.useRealTimers()
  })

  it('executes successful operation and records metrics', async () => {
    const breaker = new CircuitBreaker('svc-success', { slidingWindowSize: 4 })
    const nowSpy = jest.spyOn(Date, 'now')
    nowSpy.mockReturnValueOnce(1000) // startTime
    nowSpy.mockReturnValueOnce(1010) // endTime

    const result = await breaker.execute(async () => 'ok')
    expect(result).toBe('ok')

    const health = breaker.getHealthInfo()
    expect(health.state).toBe(CircuitState.CLOSED)
    expect(health.metrics.totalCalls).toBe(1)
    expect(health.metrics.successfulCalls).toBe(1)
    expect(health.metrics.failedCalls).toBe(0)
    expect(health.metrics.rejectedCalls).toBe(0)
    expect(health.metrics.averageResponseTimeMs).toBe(10)
    expect(health.metrics.lastSuccessTime).not.toBeNull()
  })

  it('opens after reaching failureThreshold', async () => {
    const breaker = new CircuitBreaker('svc-fail-threshold', {
      failureThreshold: 2,
      failureRateThreshold: 1,
      timeoutMs: 1000,
    })
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => 0)

    await expect(
      breaker.execute(async () => {
        throw new Error('fail1')
      })
    ).rejects.toThrow('fail1')

    await expect(
      breaker.execute(async () => {
        throw new Error('fail2')
      })
    ).rejects.toThrow('fail2')

    expect(breaker.getState()).toBe(CircuitState.OPEN)

    await expect(breaker.execute(async () => 'will-be-blocked')).rejects.toBeInstanceOf(
      CircuitBreakerOpenError
    )

    const health = breaker.getHealthInfo()
    expect(health.metrics.failedCalls).toBe(2)
    expect(health.metrics.totalCalls).toBe(2) // blocked call not counted as total
    expect(health.metrics.rejectedCalls).toBe(1)
    expect(health.metrics.stateTransitions).toBe(1) // CLOSED -> OPEN
  })

  it('opens based on failureRateThreshold and sliding window', async () => {
    const breaker = new CircuitBreaker('svc-fail-rate', {
      failureThreshold: 100,
      failureRateThreshold: 0.5,
      slidingWindowSize: 4,
    })
    jest.spyOn(Date, 'now').mockImplementation(() => 0)

    // 3 failures => 3/4 = 0.75 failure rate => open
    for (let i = 0; i < 3; i++) {
      await expect(
        breaker.execute(async () => {
          throw new Error('boom')
        })
      ).rejects.toThrow('boom')
    }
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    await expect(breaker.execute(async () => 'blocked')).rejects.toBeInstanceOf(
      CircuitBreakerOpenError
    )
  })

  it('transitions OPEN -> HALF_OPEN after timeout and closes after enough successes', async () => {
    let now = 0
    jest.spyOn(Date, 'now').mockImplementation(() => now)

    const breaker = new CircuitBreaker('svc-half-open-close', {
      failureThreshold: 1,
      successThreshold: 2,
      halfOpenMaxCalls: 2,
      timeoutMs: 1000,
    })

    // Trigger open
    await expect(
      breaker.execute(async () => {
        throw new Error('fail')
      })
    ).rejects.toThrow('fail')
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    // Advance time past timeout and call getState to transition
    now = 1000
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)

    // Two successful probes should close it
    now += 1
    await breaker.execute(async () => 'ok1')
    now += 1
    await breaker.execute(async () => 'ok2')

    expect(breaker.getState()).toBe(CircuitState.CLOSED)
    const health = breaker.getHealthInfo()
    // Transitions: CLOSED->OPEN, OPEN->HALF_OPEN, HALF_OPEN->CLOSED
    expect(health.metrics.stateTransitions).toBe(3)
  })

  it('enforces halfOpenMaxCalls and rejects extra calls with remainingTimeMs=0', async () => {
    let now = 0
    jest.spyOn(Date, 'now').mockImplementation(() => now)

    const breaker = new CircuitBreaker('svc-half-open-cap', {
      failureThreshold: 1,
      successThreshold: 2,
      halfOpenMaxCalls: 1,
      timeoutMs: 1000,
    })

    // Open it
    await expect(
      breaker.execute(async () => {
        throw new Error('fail')
      })
    ).rejects.toThrow()

    now = 1000
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)

    // First call allowed
    await breaker.execute(async () => 'ok')

    // Second call exceeds half-open capacity and is rejected
    await expect(breaker.execute(async () => 'blocked')).rejects.toBeInstanceOf(
      CircuitBreakerOpenError
    )
    try {
      await breaker.execute(async () => 'blocked')
    } catch (e: any) {
      expect(e).toBeInstanceOf(CircuitBreakerOpenError)
      expect(e.remainingTimeMs).toBe(0)
    }
    const health = breaker.getHealthInfo()
    expect(health.metrics.rejectedCalls).toBeGreaterThanOrEqual(1)
  })

  it('failure in HALF_OPEN re-opens circuit', async () => {
    let now = 0
    jest.spyOn(Date, 'now').mockImplementation(() => now)

    const breaker = new CircuitBreaker('svc-half-open-fail', {
      failureThreshold: 1,
      successThreshold: 2,
      halfOpenMaxCalls: 2,
      timeoutMs: 1000,
    })

    // Open
    await expect(
      breaker.execute(async () => {
        throw new Error('fail')
      })
    ).rejects.toThrow()
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    // Move to half open
    now = 1000
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)

    // A failure in HALF_OPEN should open again
    await expect(
      breaker.execute(async () => {
        throw new Error('probe-fail')
      })
    ).rejects.toThrow('probe-fail')
    expect(breaker.getState()).toBe(CircuitState.OPEN)
  })

  it('returns fallback when circuit is open (async execute)', async () => {
    const breaker = new CircuitBreaker('svc-fallback-async', {
      failureThreshold: 1,
      timeoutMs: 1000,
    })
    jest.spyOn(Date, 'now').mockImplementation(() => 0)

    // Open
    await expect(
      breaker.execute(async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow()

    const value = await breaker.execute(
      async () => 'should-not-run',
      async () => 'fallback'
    )
    expect(value).toBe('fallback')

    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(1) // only the original failure counted
    expect(health.metrics.rejectedCalls).toBe(1)
  })

  it('executeSync supports fallback and throws when none provided', () => {
    const breaker = new CircuitBreaker('svc-sync', {
      failureThreshold: 1,
      timeoutMs: 1000,
    })
    jest.spyOn(Date, 'now').mockImplementation(() => 0)

    // Open via sync failure
    expect(() =>
      breaker.executeSync(() => {
        throw new Error('sync-fail')
      })
    ).toThrow('sync-fail')
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    // With fallback
    const v = breaker.executeSync(
      () => 'not-called',
      () => 'fallback'
    )
    expect(v).toBe('fallback')

    // Without fallback throws CircuitBreakerOpenError
    expect(() => breaker.executeSync(() => 'not-called')).toThrow(CircuitBreakerOpenError)
  })

  it('tracks averageResponseTimeMs and caps stored samples at 100', () => {
    let now = 0
    jest.spyOn(Date, 'now').mockImplementation(() => now)

    const breaker = new CircuitBreaker('svc-avg')

    for (let i = 0; i < 120; i++) {
      now = i * 10
      breaker.executeSync(() => {
        // simulate 5ms work
        now += 5
        return 'ok'
      })
    }

    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(120)
    // since every duration was 5ms, average should be approximately 5
    expect(health.metrics.averageResponseTimeMs).toBe(5)
  })

  it('success in CLOSED reduces failureCount by 1 (down to 0 min)', async () => {
    const breaker = new CircuitBreaker('svc-reduce-failure', {
      failureThreshold: 10,
      failureRateThreshold: 1,
    })

    // two failures
    await expect(
      breaker.execute(async () => {
        throw new Error('f1')
      })
    ).rejects.toThrow()
    await expect(
      breaker.execute(async () => {
        throw new Error('f2')
      })
    ).rejects.toThrow()

    let info = breaker.getHealthInfo()
    expect(info.failureCount).toBe(2)
    expect(info.state).toBe(CircuitState.CLOSED)

    await breaker.execute(async () => 'ok')
    info = breaker.getHealthInfo()
    expect(info.failureCount).toBe(1)
  })

  it('getHealthInfo returns immutable metrics snapshot', async () => {
    const breaker = new CircuitBreaker('svc-health-immut')

    await breaker.execute(async () => 'ok')
    const info1 = breaker.getHealthInfo()
    expect(info1.metrics.totalCalls).toBe(1)

    // mutate returned metrics
    info1.metrics.failedCalls = 9999
    info1.metrics.successfulCalls = 0

    const info2 = breaker.getHealthInfo()
    expect(info2.metrics.failedCalls).not.toBe(9999)
    expect(info2.metrics.successfulCalls).toBe(1)

    // config includes only selected keys
    expect(info2.config).toHaveProperty('failureThreshold')
    expect(info2.config).toHaveProperty('successThreshold')
    expect(info2.config).toHaveProperty('timeoutMs')
    expect((info2.config as any).halfOpenMaxCalls).toBeUndefined()
  })

  it('getRegistry returns copy that does not affect actual registry', () => {
    const name = 'registry-svc-' + Math.random().toString(36).slice(2)
    CircuitBreaker.getOrCreate(name)
    const reg1 = CircuitBreaker.getRegistry()
    reg1.set('fake', new CircuitBreaker('fake'))

    const reg2 = CircuitBreaker.getRegistry()
    expect(reg2.has('fake')).toBe(false)

    const b1 = CircuitBreaker.getOrCreate(name)
    const b2 = CircuitBreaker.getOrCreate(name)
    expect(b1).toBe(b2)
  })
})

describe('withCircuitBreaker decorator', () => {
  afterEach(() => {
    jest.clearAllMocks()
    jest.restoreAllMocks()
  })

  it('wraps method with a circuit breaker from registry', async () => {
    class Service {
      async run(fail: boolean): Promise<string> {
        if (fail) throw new Error('boom')
        return 'ok'
      }
    }

    const decorator = withCircuitBreaker('decor-svc', { failureThreshold: 1, timeoutMs: 1000 })
    const desc = Object.getOwnPropertyDescriptor(Service.prototype, 'run')!
    decorator(Service.prototype, 'run', desc)
    Object.defineProperty(Service.prototype, 'run', desc)

    const svc = new Service()

    await expect(svc.run(true)).rejects.toThrow('boom')

    // breaker should now be open (threshold 1)
    await expect(svc.run(false)).rejects.toBeInstanceOf(CircuitBreakerOpenError)

    const breaker = CircuitBreaker.getOrCreate('decor-svc')
    expect(breaker.getState()).toBe(CircuitState.OPEN)
  })
})

describe('DistributedCircuitBreakerClient', () => {
  let originalNodeId: string | undefined
  beforeEach(() => {
    originalNodeId = process.env.NODE_ID
  })
  afterEach(() => {
    jest.clearAllMocks()
    jest.restoreAllMocks()
    jest.useRealTimers()
    if (originalNodeId === undefined) {
      delete process.env.NODE_ID
    } else {
      process.env.NODE_ID = originalNodeId
    }
  })

  it('register sends registration with NODE_ID', async () => {
    process.env.NODE_ID = 'node-abc'
    const fetchMock = jest.fn().mockResolvedValue({ json: jest.fn() })
    ;(global as any).fetch = fetchMock

    const client = new DistributedCircuitBreakerClient('http://coordinator')
    const breaker = new CircuitBreaker('reg-svc', { failureThreshold: 7, successThreshold: 3 })
    client.register(breaker)

    await flush()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://coordinator/circuit-breakers/register')
    expect((init as any).method).toBe('POST')
    const body = JSON.parse((init as any).body)
    expect(body.service).toBe('reg-svc')
    expect(body.node_id).toBe('node-abc')
    expect(body.failure_threshold).toBe(breaker.getHealthInfo().config.failureThreshold)
    expect(body.success_threshold).toBe(breaker.getHealthInfo().config.successThreshold)
  })

  it('getAggregatedState returns remote value on success', async () => {
    const agg = {
      service: 'svc',
      consensusState: CircuitState.OPEN,
      totalNodes: 5,
      healthScore: 0.8,
      nodeStates: { a: CircuitState.OPEN },
    }
    const fetchMock = jest.fn().mockResolvedValue({ json: jest.fn().mockResolvedValue(agg) })
    ;(global as any).fetch = fetchMock

    const client = new DistributedCircuitBreakerClient('http://coord')
    const res = await client.getAggregatedState('svc')
    expect(res).toEqual(agg)
    expect(fetchMock).toHaveBeenCalledWith('http://coord/circuit-breakers/svc/aggregate')
  })

  it('getAggregatedState returns default on fetch error', async () => {
    const fetchMock = jest.fn().mockRejectedValue(new Error('network'))
    ;(global as any).fetch = fetchMock

    const client = new DistributedCircuitBreakerClient('http://coord')
    const res = await client.getAggregatedState('svc-x')
    expect(res.service).toBe('svc-x')
    expect(res.consensusState).toBe(CircuitState.CLOSED)
    expect(res.totalNodes).toBe(0)
  })

  it('startSync posts state periodically and stopSync stops it', async () => {
    jest.useFakeTimers()
    process.env.NODE_ID = 'node-sync'
    const fetchMock = jest.fn().mockResolvedValue({ json: jest.fn() })
    ;(global as any).fetch = fetchMock

    const client = new DistributedCircuitBreakerClient('http://coord', 100)
    const breaker = new CircuitBreaker('sync-svc')
    client.register(breaker)
    await flush()

    client.startSync()
    // calling startSync again should not create another interval
    client.startSync()

    jest.advanceTimersByTime(100)
    await flush()
    jest.advanceTimersByTime(100)
    await flush()

    // first call for registration + 2 reportState calls
    expect(fetchMock).toHaveBeenCalledTimes(3)

    // inspect the latest reportState call
    const lastCall = fetchMock.mock.calls[fetchMock.mock.calls.length - 1]
    const [url, init] = lastCall
    expect(url).toBe('http://coord/circuit-breakers/state')
    expect((init as any).method).toBe('POST')
    const body = JSON.parse((init as any).body)
    expect(body.service).toBe('sync-svc')
    expect(body.node_id).toBe('node-sync')
    expect(Object.values(CircuitState)).toContain(body.state)
    expect(typeof body.timestamp).toBe('number')
    expect(body.health_info.name).toBe('sync-svc')

    // stop sync and ensure no further posts
    client.stopSync()
    jest.advanceTimersByTime(300)
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('reporting uses fallback node id when NODE_ID is not set', async () => {
    delete process.env.NODE_ID
    jest.useFakeTimers()
    const fetchMock = jest.fn().mockResolvedValue({ json: jest.fn() })
    ;(global as any).fetch = fetchMock

    const client = new DistributedCircuitBreakerClient('http://coord', 50)
    const breaker = new CircuitBreaker('no-node-id-svc')
    client.register(breaker)
    await flush()
    client.startSync()

    jest.advanceTimersByTime(50)
    await flush()

    const [, init] = fetchMock.mock.calls[1] // second call is state report
    const body = JSON.parse((init as any).body)
    expect(body.node_id).toMatch(/^ts-/)
    client.stopSync()
  })
})