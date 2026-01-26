import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals'
import {
  CircuitBreaker,
  CircuitState,
  CircuitBreakerOpenError,
  DistributedCircuitBreakerClient,
  withCircuitBreaker,
} from '../src/circuit-breaker'

afterEach(() => {
  jest.clearAllMocks()
})

const setImmediatePromise = () => new Promise((resolve) => setTimeout(resolve, 0))

function mockNowSequence(values: number[]) {
  let i = 0
  return jest.spyOn(Date, 'now').mockImplementation(() => {
    const idx = i < values.length ? i : values.length - 1
    const val = values[idx]
    i++
    return val
  })
}

function mockNow(value: number) {
  return jest.spyOn(Date, 'now').mockReturnValue(value)
}

describe('CircuitBreakerOpenError', () => {
  it('formats message and sets properties', () => {
    const err = new CircuitBreakerOpenError('svc', 1234)
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('CircuitBreakerOpenError')
    expect(err.remainingTimeMs).toBe(1234)
    expect(err.message).toContain("Circuit breaker 'svc' is open")
    expect(err.message).toContain('1234ms')
  })
})

describe('CircuitBreaker basic behavior', () => {
  it('executes successfully when closed and updates metrics', async () => {
    const breaker = new CircuitBreaker('t-success', { slidingWindowSize: 2 })
    const result = await breaker.execute(async () => 'ok')
    expect(result).toBe('ok')
    const health = breaker.getHealthInfo()
    expect(health.state).toBe(CircuitState.CLOSED)
    expect(health.metrics.totalCalls).toBe(1)
    expect(health.metrics.successfulCalls).toBe(1)
    expect(health.metrics.failedCalls).toBe(0)
    expect(health.metrics.lastSuccessTime).toBeInstanceOf(Date)
  })

  it('opens after reaching failure threshold and rejects further calls with remaining time', async () => {
    const breaker = new CircuitBreaker('t-open-by-count', {
      failureThreshold: 2,
      failureRateThreshold: 1,
      timeoutMs: 1000,
      slidingWindowSize: 2,
    })

    await expect(
      breaker.execute(async () => {
        throw new Error('fail-1')
      })
    ).rejects.toThrow('fail-1')

    const openAtSpy = mockNow(1000)
    await expect(
      breaker.execute(async () => {
        throw new Error('fail-2')
      })
    ).rejects.toThrow('fail-2')
    openAtSpy.mockRestore()

    const callWhileOpenSpy = mockNow(1200)
    await expect(
      breaker.execute(async () => 'should-not-run')
    ).rejects.toBeInstanceOf(CircuitBreakerOpenError)
    callWhileOpenSpy.mockRestore()

    const health = breaker.getHealthInfo()
    expect(health.state).toBe(CircuitState.OPEN)
    expect(health.metrics.failedCalls).toBe(2)
    expect(health.metrics.rejectedCalls).toBe(1)
    expect(health.metrics.stateTransitions).toBe(1)

    try {
      const spy = mockNow(1200)
      await breaker.execute(async () => 'nope')
      spy.mockRestore()
    } catch (e: any) {
      expect(e).toBeInstanceOf(CircuitBreakerOpenError)
      expect(e.remainingTimeMs).toBe(800)
      expect(e.message).toContain("Circuit breaker 't-open-by-count' is open")
      expect(e.message).toContain('800ms')
    }
  })

  it('uses fallback when open', async () => {
    const breaker = new CircuitBreaker('t-fallback-open', {
      failureThreshold: 1,
      failureRateThreshold: 1,
      timeoutMs: 1000,
      slidingWindowSize: 2,
    })

    const openAtSpy = mockNow(0)
    await expect(
      breaker.execute(async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    openAtSpy.mockRestore()

    const fallbackSpy = mockNow(500)
    const value = await breaker.execute(
      async () => 'no-run',
      async () => 'fallback-value'
    )
    fallbackSpy.mockRestore()
    expect(value).toBe('fallback-value')
    const health = breaker.getHealthInfo()
    expect(health.metrics.rejectedCalls).toBe(1)
  })

  it('executeSync success updates metrics', () => {
    const breaker = new CircuitBreaker('t-sync-success')
    const res = breaker.executeSync(() => 42)
    expect(res).toBe(42)
    const h = breaker.getHealthInfo()
    expect(h.metrics.totalCalls).toBe(1)
    expect(h.metrics.successfulCalls).toBe(1)
  })

  it('executeSync failure opens when threshold reached', () => {
    const breaker = new CircuitBreaker('t-sync-open', {
      failureThreshold: 1,
      failureRateThreshold: 1,
      slidingWindowSize: 2,
      timeoutMs: 1000,
    })
    expect(() =>
      breaker.executeSync(() => {
        throw new Error('sync-fail')
      })
    ).toThrow('sync-fail')
    expect(breaker.getState()).toBe(CircuitState.OPEN)
    const h = breaker.getHealthInfo()
    expect(h.metrics.failedCalls).toBe(1)
    expect(h.metrics.stateTransitions).toBe(1)
  })
})

describe('CircuitBreaker state transitions', () => {
  it('transitions to HALF_OPEN after timeout, then to CLOSED after enough successes', async () => {
    const breaker = new CircuitBreaker('t-halfopen-success', {
      failureThreshold: 1,
      successThreshold: 2,
      halfOpenMaxCalls: 3,
      timeoutMs: 100,
      slidingWindowSize: 2,
      failureRateThreshold: 1,
    })

    const openSpy = mockNow(0)
    await expect(
      breaker.execute(async () => {
        throw new Error('fail')
      })
    ).rejects.toThrow('fail')
    openSpy.mockRestore()
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    const toHalfOpenSpy = mockNow(150)
    const r1 = await breaker.execute(async () => 'ok1')
    expect(r1).toBe('ok1')
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)

    const r2 = await breaker.execute(async () => 'ok2')
    expect(r2).toBe('ok2')
    expect(breaker.getState()).toBe(CircuitState.CLOSED)
    toHalfOpenSpy.mockRestore()

    const h = breaker.getHealthInfo()
    expect(h.metrics.stateTransitions).toBe(3)
    expect(h.failureCount).toBe(0)
  })

  it('limits number of calls in HALF_OPEN and rejects extra with 0ms remaining', async () => {
    const breaker = new CircuitBreaker('t-halfopen-limit', {
      failureThreshold: 1,
      successThreshold: 10,
      halfOpenMaxCalls: 1,
      timeoutMs: 100,
      slidingWindowSize: 2,
      failureRateThreshold: 1,
    })

    const openSpy = mockNow(0)
    await expect(
      breaker.execute(async () => {
        throw new Error('trip-open')
      })
    ).rejects.toThrow('trip-open')
    openSpy.mockRestore()

    const halfOpenSpy = mockNow(200)
    await expect(breaker.execute(async () => 'first-allowed')).resolves.toBe('first-allowed')
    await expect(
      breaker.execute(async () => 'should-reject')
    ).rejects.toBeInstanceOf(CircuitBreakerOpenError)
    halfOpenSpy.mockRestore()

    try {
      const spy = mockNow(200)
      await breaker.execute(async () => 'nope')
      spy.mockRestore()
    } catch (e: any) {
      expect(e).toBeInstanceOf(CircuitBreakerOpenError)
      expect(e.remainingTimeMs).toBe(0)
      expect(e.message).toContain('0ms')
    }
  })

  it('failure in HALF_OPEN reopens circuit', async () => {
    const breaker = new CircuitBreaker('t-halfopen-failure', {
      failureThreshold: 1,
      successThreshold: 2,
      halfOpenMaxCalls: 2,
      timeoutMs: 100,
      slidingWindowSize: 2,
      failureRateThreshold: 1,
    })

    const openSpy = mockNow(0)
    await expect(
      breaker.execute(async () => {
        throw new Error('boom-open')
      })
    ).rejects.toThrow('boom-open')
    openSpy.mockRestore()

    const toHalfSpy = mockNow(200)
    await expect(
      breaker.execute(async () => {
        throw new Error('half-open-failure')
      })
    ).rejects.toThrow('half-open-failure')
    toHalfSpy.mockRestore()

    expect(breaker.getState()).toBe(CircuitState.OPEN)
    const h = breaker.getHealthInfo()
    expect(h.metrics.stateTransitions).toBe(3)
  })

  it('success in CLOSED reduces failureCount by 1 (not below 0)', async () => {
    const breaker = new CircuitBreaker('t-reduce-failure', {
      failureThreshold: 10,
      failureRateThreshold: 1,
      slidingWindowSize: 10,
    })

    await expect(
      breaker.execute(async () => {
        throw new Error('f1')
      })
    ).rejects.toThrow('f1')
    await expect(
      breaker.execute(async () => {
        throw new Error('f2')
      })
    ).rejects.toThrow('f2')

    let h = breaker.getHealthInfo()
    expect(h.failureCount).toBe(2)

    await breaker.execute(async () => 'success')
    h = breaker.getHealthInfo()
    expect(h.failureCount).toBe(1)

    await breaker.execute(async () => 'success-2')
    h = breaker.getHealthInfo()
    expect(h.failureCount).toBe(0)
  })

  it('opens based on failureRateThreshold using sliding window', async () => {
    const breaker = new CircuitBreaker('t-open-by-rate', {
      failureThreshold: 10,
      failureRateThreshold: 0.5,
      slidingWindowSize: 2,
      timeoutMs: 1000,
    })

    await expect(
      breaker.execute(async () => {
        throw new Error('f1')
      })
    ).rejects.toThrow('f1')

    await expect(
      breaker.execute(async () => {
        throw new Error('f2')
      })
    ).rejects.toThrow('f2')

    expect(breaker.getState()).toBe(CircuitState.OPEN)
    const h = breaker.getHealthInfo()
    expect(h.metrics.stateTransitions).toBe(1)
  })

  it('tracks average response time over multiple successes', async () => {
    const breaker = new CircuitBreaker('t-avg-rt')

    const spy = mockNowSequence([0, 100, 200, 400])
    await breaker.execute(async () => 'a')
    await breaker.execute(async () => 'b')
    spy.mockRestore()

    const h = breaker.getHealthInfo()
    expect(h.metrics.successfulCalls).toBe(2)
    expect(h.metrics.averageResponseTimeMs).toBeCloseTo(150, 5)
  })
})

describe('CircuitBreaker registry', () => {
  it('getOrCreate returns same instance for same name and registry contains it', () => {
    const a = CircuitBreaker.getOrCreate('reg-svc')
    const b = CircuitBreaker.getOrCreate('reg-svc')
    expect(a).toBe(b)
    const reg = CircuitBreaker.getRegistry()
    expect(reg.has('reg-svc')).toBe(true)
    expect(reg.get('reg-svc')).toBe(a)
  })
})

describe('DistributedCircuitBreakerClient', () => {
  it('register sends registration payload', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true })
    ;(global as any).fetch = fetchMock

    const client = new DistributedCircuitBreakerClient('http://coord')
    const breaker = new CircuitBreaker('svc-register', {
      failureThreshold: 7,
      successThreshold: 4,
    })

    client.register(breaker)
    await setImmediatePromise()

    expect(fetchMock).toHaveBeenCalled()
    const call = fetchMock.mock.calls.find((c: any) =>
      (c[0] as string).includes('/circuit-breakers/register')
    )
    expect(call).toBeTruthy()
    const url = call![0]
    const options = call![1]
    expect(url).toBe('http://coord/circuit-breakers/register')
    expect(options.method).toBe('POST')
    const body = JSON.parse(options.body)
    expect(body.service).toBe('svc-register')
    expect(typeof body.node_id).toBe('string')
    expect(body.failure_threshold).toBe(7)
    expect(body.success_threshold).toBe(4)
  })

  it('getAggregatedState returns data from coordinator', async () => {
    const aggregated = {
      service: 'svc-agg',
      consensusState: CircuitState.HALF_OPEN,
      totalNodes: 3,
      healthScore: 0.8,
      nodeStates: { a: CircuitState.CLOSED, b: CircuitState.OPEN, c: CircuitState.HALF_OPEN },
    }
    const fetchMock = jest.fn().mockResolvedValue({
      json: jest.fn().mockResolvedValue(aggregated),
    })
    ;(global as any).fetch = fetchMock

    const client = new DistributedCircuitBreakerClient('http://coord')
    const res = await client.getAggregatedState('svc-agg')
    expect(res).toEqual(aggregated)
    expect(fetchMock).toHaveBeenCalledWith(
      'http://coord/circuit-breakers/svc-agg/aggregate'
    )
  })

  it('getAggregatedState returns default on failure', async () => {
    const fetchMock = jest.fn().mockRejectedValue(new Error('network'))
    ;(global as any).fetch = fetchMock

    const client = new DistributedCircuitBreakerClient('http://coord')
    const res = await client.getAggregatedState('svc-default')
    expect(res.service).toBe('svc-default')
    expect(res.consensusState).toBe(CircuitState.CLOSED)
    expect(res.totalNodes).toBe(0)
    expect(res.nodeStates).toEqual({})
  })

  it('startSync periodically reports state', async () => {
    jest.useFakeTimers()
    const fetchMock = jest.fn().mockResolvedValue({ ok: true })
    ;(global as any).fetch = fetchMock

    const client = new DistributedCircuitBreakerClient('http://coord', 200)
    const breaker = new CircuitBreaker('svc-sync')
    client.register(breaker)
    await setImmediatePromise()

    client.startSync()
    jest.advanceTimersByTime(200)
    await Promise.resolve()
    jest.advanceTimersByTime(200)
    await Promise.resolve()

    const stateCalls = fetchMock.mock.calls.filter((c: any) =>
      (c[0] as string).includes('/circuit-breakers/state')
    )
    expect(stateCalls.length).toBeGreaterThanOrEqual(1)
    client.stopSync()
    jest.useRealTimers()
  })
})

describe('withCircuitBreaker decorator', () => {
  it('wraps method with circuit breaker and opens after failures', async () => {
    class Service {
      async risky(arg: string): Promise<string> {
        if (arg === 'fail') throw new Error('boom')
        return `ok:${arg}`
      }
    }
    const config = { failureThreshold: 1, slidingWindowSize: 2, failureRateThreshold: 1, timeoutMs: 1000 }
    const decorator = withCircuitBreaker('decor-unique-1', config)
    const original = Object.getOwnPropertyDescriptor(Service.prototype, 'risky')!
    const modified = decorator(Service.prototype, 'risky', original) || original
    Object.defineProperty(Service.prototype, 'risky', modified)
    const svc = new Service()

    await expect(svc.risky('a')).resolves.toBe('ok:a')
    await expect(svc.risky('fail')).rejects.toThrow('boom')
    await expect(svc.risky('b')).rejects.toBeInstanceOf(CircuitBreakerOpenError)
  })
})