import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  CircuitBreaker,
  CircuitBreakerOpenError,
  CircuitState,
  DistributedCircuitBreakerClient,
  withCircuitBreaker,
} from '../src/circuit-breaker'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2020-01-01T00:00:00.000Z'))
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('CircuitBreaker basic behavior', () => {
  it('starts CLOSED with default health info and empty metrics', () => {
    const breaker = new CircuitBreaker('svc-default')

    expect(breaker.getState()).toBe(CircuitState.CLOSED)

    const health = breaker.getHealthInfo()
    expect(health.name).toBe('svc-default')
    expect(health.state).toBe(CircuitState.CLOSED)
    expect(health.failureCount).toBe(0)
    expect(health.successCount).toBe(0)
    expect(health.failureRate).toBe(0)
    expect(health.metrics.totalCalls).toBe(0)
    expect(health.metrics.successfulCalls).toBe(0)
    expect(health.metrics.failedCalls).toBe(0)
    expect(health.metrics.rejectedCalls).toBe(0)
    expect(health.metrics.stateTransitions).toBe(0)
    expect(health.metrics.lastFailureTime).toBeNull()
    expect(health.metrics.lastSuccessTime).toBeNull()
    expect(health.metrics.averageResponseTimeMs).toBe(0)

    expect(health.config).toEqual({
      failureThreshold: 5,
      successThreshold: 3,
      timeoutMs: 30000,
    })
  })

  it('execute() records success metrics and returns result', async () => {
    const breaker = new CircuitBreaker('svc-success')

    vi.setSystemTime(new Date('2020-01-01T00:00:00.000Z'))
    const operation = vi.fn(async () => {
      vi.advanceTimersByTime(12)
      return 'ok'
    })

    const result = await breaker.execute(operation)

    expect(result).toBe('ok')
    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(1)
    expect(health.metrics.successfulCalls).toBe(1)
    expect(health.metrics.failedCalls).toBe(0)
    expect(health.metrics.rejectedCalls).toBe(0)
    expect(health.metrics.lastSuccessTime).toBeInstanceOf(Date)
    expect(health.metrics.averageResponseTimeMs).toBe(12)
    expect(breaker.getState()).toBe(CircuitState.CLOSED)
  })

  it('execute() records failure metrics and rethrows original error', async () => {
    const breaker = new CircuitBreaker('svc-fail')
    const err = new Error('boom')

    const operation = vi.fn(async () => {
      vi.advanceTimersByTime(7)
      throw err
    })

    await expect(breaker.execute(operation)).rejects.toBe(err)

    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(1)
    expect(health.metrics.successfulCalls).toBe(0)
    expect(health.metrics.failedCalls).toBe(1)
    expect(health.metrics.lastFailureTime).toBeInstanceOf(Date)
    expect(health.metrics.averageResponseTimeMs).toBe(7)
  })

  it('executeSync() records success metrics and returns result', () => {
    const breaker = new CircuitBreaker('svc-sync-success')

    const operation = vi.fn(() => {
      vi.advanceTimersByTime(3)
      return 123
    })

    const result = breaker.executeSync(operation)

    expect(result).toBe(123)
    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(1)
    expect(health.metrics.successfulCalls).toBe(1)
    expect(health.metrics.failedCalls).toBe(0)
    expect(health.metrics.averageResponseTimeMs).toBe(3)
  })

  it('executeSync() records failure metrics and rethrows', () => {
    const breaker = new CircuitBreaker('svc-sync-fail')
    const err = new Error('sync boom')

    const operation = vi.fn(() => {
      vi.advanceTimersByTime(4)
      throw err
    })

    expect(() => breaker.executeSync(operation)).toThrow(err)
    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(1)
    expect(health.metrics.failedCalls).toBe(1)
    expect(health.metrics.averageResponseTimeMs).toBe(4)
  })
})

describe('CircuitBreaker state transitions and rejection behavior', () => {
  it('opens when failureThreshold is reached and then rejects without fallback', async () => {
    const breaker = new CircuitBreaker('svc-open-threshold', {
      failureThreshold: 2,
      slidingWindowSize: 10,
      failureRateThreshold: 1, // avoid opening by rate unless all fail; threshold will trigger anyway
      timeoutMs: 1000,
    })

    await expect(
      breaker.execute(async () => {
        vi.advanceTimersByTime(1)
        throw new Error('f1')
      })
    ).rejects.toThrow('f1')

    expect(breaker.getState()).toBe(CircuitState.CLOSED)

    await expect(
      breaker.execute(async () => {
        vi.advanceTimersByTime(1)
        throw new Error('f2')
      })
    ).rejects.toThrow('f2')

    expect(breaker.getState()).toBe(CircuitState.OPEN)

    // immediately rejected
    await expect(
      breaker.execute(async () => 'should-not-run')
    ).rejects.toBeInstanceOf(CircuitBreakerOpenError)

    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(2)
    expect(health.metrics.failedCalls).toBe(2)
    expect(health.metrics.rejectedCalls).toBe(1)
    expect(health.metrics.stateTransitions).toBe(1)
  })

  it('when OPEN and fallback is provided, it returns fallback result and increments rejectedCalls', async () => {
    const breaker = new CircuitBreaker('svc-open-fallback', {
      failureThreshold: 1,
      timeoutMs: 5000,
    })

    await expect(
      breaker.execute(async () => {
        throw new Error('fail-once')
      })
    ).rejects.toThrow('fail-once')

    expect(breaker.getState()).toBe(CircuitState.OPEN)

    const fallback = vi.fn(async () => 'fb')
    const operation = vi.fn(async () => 'op')

    const val = await breaker.execute(operation, fallback)
    expect(val).toBe('fb')
    expect(operation).not.toHaveBeenCalled()
    expect(fallback).toHaveBeenCalledTimes(1)

    const health = breaker.getHealthInfo()
    expect(health.metrics.rejectedCalls).toBe(1)
    expect(health.metrics.totalCalls).toBe(1)
  })

  it('CircuitBreakerOpenError reports remainingTimeMs based on openedAt and timeoutMs', async () => {
    const breaker = new CircuitBreaker('svc-open-error-remaining', {
      failureThreshold: 1,
      timeoutMs: 1000,
    })

    vi.setSystemTime(new Date('2020-01-01T00:00:00.000Z'))
    await expect(breaker.execute(async () => Promise.reject(new Error('x')))).rejects.toThrow()

    expect(breaker.getState()).toBe(CircuitState.OPEN)

    // 200ms after opened
    vi.advanceTimersByTime(200)
    await expect(breaker.execute(async () => 'nope')).rejects.toMatchObject({
      name: 'CircuitBreakerOpenError',
    })

    try {
      await breaker.execute(async () => 'nope')
      throw new Error('unreachable')
    } catch (e: any) {
      expect(e).toBeInstanceOf(CircuitBreakerOpenError)
      expect(e.name).toBe('CircuitBreakerOpenError')
      expect(e.remainingTimeMs).toBeGreaterThanOrEqual(0)
      expect(e.remainingTimeMs).toBeLessThanOrEqual(800)
      expect(String(e.message)).toContain("Circuit breaker 'svc-open-error-remaining' is open")
    }
  })

  it('transitions from OPEN to HALF_OPEN after timeout when getState is called', async () => {
    const breaker = new CircuitBreaker('svc-half-open', {
      failureThreshold: 1,
      timeoutMs: 1000,
    })

    await expect(breaker.execute(async () => Promise.reject(new Error('x')))).rejects.toThrow()
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    // before timeout: still OPEN
    vi.advanceTimersByTime(999)
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    // after timeout: getState triggers HALF_OPEN
    vi.advanceTimersByTime(1)
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)

    const health = breaker.getHealthInfo()
    expect(health.metrics.stateTransitions).toBe(2) // CLOSED->OPEN, OPEN->HALF_OPEN
  })

  it('HALF_OPEN allows up to halfOpenMaxCalls then rejects further requests', async () => {
    const breaker = new CircuitBreaker('svc-half-open-maxcalls', {
      failureThreshold: 1,
      timeoutMs: 1000,
      halfOpenMaxCalls: 2,
      successThreshold: 10, // keep it HALF_OPEN even if successes occur
    })

    await expect(breaker.execute(async () => Promise.reject(new Error('x')))).rejects.toThrow()
    vi.advanceTimersByTime(1000)
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)

    const op1 = vi.fn(async () => 'a')
    const op2 = vi.fn(async () => 'b')
    const op3 = vi.fn(async () => 'c')

    await expect(breaker.execute(op1)).resolves.toBe('a')
    await expect(breaker.execute(op2)).resolves.toBe('b')
    await expect(breaker.execute(op3)).rejects.toBeInstanceOf(CircuitBreakerOpenError)

    expect(op1).toHaveBeenCalledTimes(1)
    expect(op2).toHaveBeenCalledTimes(1)
    expect(op3).not.toHaveBeenCalled()

    const health = breaker.getHealthInfo()
    expect(health.metrics.rejectedCalls).toBe(1)
  })

  it('in HALF_OPEN, a single failure re-opens the circuit', async () => {
    const breaker = new CircuitBreaker('svc-half-open-failure', {
      failureThreshold: 1,
      timeoutMs: 1000,
      successThreshold: 2,
    })

    await expect(breaker.execute(async () => Promise.reject(new Error('x')))).rejects.toThrow()
    vi.advanceTimersByTime(1000)
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)

    await expect(breaker.execute(async () => Promise.reject(new Error('half-open-fail')))).rejects.toThrow(
      'half-open-fail'
    )
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    const health = breaker.getHealthInfo()
    expect(health.metrics.stateTransitions).toBe(3) // CLOSED->OPEN->HALF_OPEN->OPEN
  })

  it('in HALF_OPEN, enough successes closes the circuit and resets counts', async () => {
    const breaker = new CircuitBreaker('svc-half-open-close', {
      failureThreshold: 1,
      timeoutMs: 1000,
      successThreshold: 2,
    })

    await expect(breaker.execute(async () => Promise.reject(new Error('x')))).rejects.toThrow()
    vi.advanceTimersByTime(1000)
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)

    await expect(breaker.execute(async () => 'ok1')).resolves.toBe('ok1')
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)

    await expect(breaker.execute(async () => 'ok2')).resolves.toBe('ok2')
    expect(breaker.getState()).toBe(CircuitState.CLOSED)

    const health = breaker.getHealthInfo()
    expect(health.failureCount).toBe(0)
    expect(health.successCount).toBe(0)
    expect(health.metrics.stateTransitions).toBe(3) // CLOSED->OPEN->HALF_OPEN->CLOSED
  })

  it('opens due to failure rate threshold in sliding window even if failureCount below failureThreshold', async () => {
    const breaker = new CircuitBreaker('svc-open-rate', {
      failureThreshold: 100,
      slidingWindowSize: 4,
      failureRateThreshold: 0.5,
      timeoutMs: 1000,
    })

    // 1 failure -> rate 0.25
    await expect(breaker.execute(async () => Promise.reject(new Error('f1')))).rejects.toThrow('f1')
    expect(breaker.getState()).toBe(CircuitState.CLOSED)

    // 2nd failure -> rate 0.5 => open
    await expect(breaker.execute(async () => Promise.reject(new Error('f2')))).rejects.toThrow('f2')
    expect(breaker.getState()).toBe(CircuitState.OPEN)
  })

  it('in CLOSED, recordSuccess decreases failureCount but not below 0', async () => {
    const breaker = new CircuitBreaker('svc-failurecount-dec', {
      failureThreshold: 10,
      slidingWindowSize: 10,
      failureRateThreshold: 1,
    })

    await expect(breaker.execute(async () => Promise.reject(new Error('f1')))).rejects.toThrow()
    await expect(breaker.execute(async () => Promise.reject(new Error('f2')))).rejects.toThrow()

    let health = breaker.getHealthInfo()
    expect(health.failureCount).toBe(2)

    await expect(breaker.execute(async () => 'ok')).resolves.toBe('ok')
    health = breaker.getHealthInfo()
    expect(health.failureCount).toBe(1)

    await expect(breaker.execute(async () => 'ok2')).resolves.toBe('ok2')
    health = breaker.getHealthInfo()
    expect(health.failureCount).toBe(0)

    await expect(breaker.execute(async () => 'ok3')).resolves.toBe('ok3')
    health = breaker.getHealthInfo()
    expect(health.failureCount).toBe(0)
  })

  it('averageResponseTimeMs is calculated over multiple calls and keeps at most 100 samples', async () => {
    const breaker = new CircuitBreaker('svc-avg', { failureThreshold: 100 })

    for (let i = 1; i <= 3; i++) {
      await breaker.execute(async () => {
        vi.advanceTimersByTime(i * 10)
        return i
      })
    }

    expect(breaker.getHealthInfo().metrics.averageResponseTimeMs).toBe((10 + 20 + 30) / 3)

    for (let i = 0; i < 110; i++) {
      await breaker.execute(async () => {
        vi.advanceTimersByTime(1)
        return i
      })
    }

    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(113)
    // after the 3 initial calls, 110 calls at duration=1 => last 100 samples all 1ms
    expect(health.metrics.averageResponseTimeMs).toBe(1)
  })
})

describe('CircuitBreaker registry behavior', () => {
  it('getOrCreate returns same instance for same name and first config wins', () => {
    const a = CircuitBreaker.getOrCreate('svc-registry', { failureThreshold: 1 })
    const b = CircuitBreaker.getOrCreate('svc-registry', { failureThreshold: 999 })

    expect(a).toBe(b)
    // config exposed is partial in health info; ensure it reflects initial construction
    expect(a.getHealthInfo().config.failureThreshold).toBe(1)
    expect(b.getHealthInfo().config.failureThreshold).toBe(1)
  })

  it('getRegistry returns a copy (mutating returned map does not affect internal registry)', () => {
    const x = CircuitBreaker.getOrCreate('svc-registry-copy')
    const reg1 = CircuitBreaker.getRegistry()
    expect(reg1.get('svc-registry-copy')).toBe(x)

    reg1.delete('svc-registry-copy')
    const reg2 = CircuitBreaker.getRegistry()
    expect(reg2.has('svc-registry-copy')).toBe(true)
  })
})

describe('withCircuitBreaker decorator', () => {
  it('wraps an async method and routes calls through breaker.execute', async () => {
    // Ensure deterministic breaker config for this name
    const breaker = CircuitBreaker.getOrCreate('decorated-service', {
      failureThreshold: 2,
      slidingWindowSize: 10,
      failureRateThreshold: 1,
      timeoutMs: 1000,
    })

    const execSpy = vi.spyOn(breaker as any, 'execute')

    class Svc {
      async work(x: number) {
        return x + 1
      }
    }

    const descriptor = Object.getOwnPropertyDescriptor(Svc.prototype, 'work')!
    withCircuitBreaker('decorated-service')(Svc.prototype, 'work', descriptor)
    Object.defineProperty(Svc.prototype, 'work', descriptor)

    const svc = new Svc()
    await expect(svc.work(10)).resolves.toBe(11)

    expect(execSpy).toHaveBeenCalledTimes(1)
    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(1)
    expect(health.metrics.successfulCalls).toBe(1)
  })

  it('decorated method calls preserve this binding', async () => {
    CircuitBreaker.getOrCreate('decorated-binding', { failureThreshold: 5 })

    class Counter {
      value = 41
      async inc(by: number) {
        return this.value + by
      }
    }

    const descriptor = Object.getOwnPropertyDescriptor(Counter.prototype, 'inc')!
    withCircuitBreaker('decorated-binding')(Counter.prototype, 'inc', descriptor)
    Object.defineProperty(Counter.prototype, 'inc', descriptor)

    const c = new Counter()
    await expect(c.inc(1)).resolves.toBe(42)
  })
})

describe('DistributedCircuitBreakerClient', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ ok: true }) })) as any)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('register() stores breaker and sends registration (best-effort)', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValueOnce({ json: async () => ({ ok: true }) } as any)

    const client = new DistributedCircuitBreakerClient('http://coordinator', 5000)
    const breaker = new CircuitBreaker('svc-reg')

    client.register(breaker)

    // allow the async registration to run
    await vi.runAllTicksAsync()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://coordinator/circuit-breakers/register')
    expect(init?.method).toBe('POST')
    expect((init?.headers as any)['Content-Type']).toBe('application/json')

    const body = JSON.parse(String(init?.body))
    expect(body.service).toBe('svc-reg')
    expect(body.node_id).toBeTruthy()
    expect(typeof body.failure_threshold).toBe('number')
    expect(typeof body.success_threshold).toBe('number')
  })

  it('startSync() sets interval only once and stopSync() clears it', async () => {
    const client = new DistributedCircuitBreakerClient('http://coordinator', 1000)
    const spySetInterval = vi.spyOn(globalThis, 'setInterval')
    const spyClearInterval = vi.spyOn(globalThis, 'clearInterval')

    client.startSync()
    client.startSync()

    expect(spySetInterval).toHaveBeenCalledTimes(1)

    client.stopSync()
    expect(spyClearInterval).toHaveBeenCalledTimes(1)

    client.stopSync()
    expect(spyClearInterval).toHaveBeenCalledTimes(1)
  })

  it('startSync triggers reporting breaker state periodically (best-effort)', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValue({ json: async () => ({ ok: true }) } as any)

    const client = new DistributedCircuitBreakerClient('http://coordinator', 1000)
    const breaker = new CircuitBreaker('svc-sync')
    client.register(breaker)

    await vi.runAllTicksAsync()
    fetchMock.mockClear()

    client.startSync()
    vi.advanceTimersByTime(1000)

    await vi.runAllTicksAsync()

    expect(fetchMock).toHaveBeenCalled()
    const stateCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith('/circuit-breakers/state')
    )
    expect(stateCalls.length).toBeGreaterThanOrEqual(1)

    const [, init] = stateCalls[0]
    expect(init?.method).toBe('POST')
    const body = JSON.parse(String(init?.body))
    expect(body.service).toBe('svc-sync')
    expect(body.node_id).toBeTruthy()
    expect(body.timestamp).toBeTypeOf('number')
    expect(body.state).toBe(CircuitState.CLOSED)
    expect(body.health_info?.name).toBe('svc-sync')

    client.stopSync()
  })

  it('getAggregatedState returns parsed JSON on success', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValueOnce({
      json: async () => ({
        service: 'svc-agg',
        consensusState: CircuitState.OPEN,
        totalNodes: 2,
        healthScore: 0.25,
        nodeStates: { a: CircuitState.OPEN, b: CircuitState.CLOSED },
      }),
    } as any)

    const client = new DistributedCircuitBreakerClient('http://coordinator')
    const agg = await client.getAggregatedState('svc-agg')

    expect(fetchMock).toHaveBeenCalledWith(
      'http://coordinator/circuit-breakers/svc-agg/aggregate'
    )
    expect(agg.service).toBe('svc-agg')
    expect(agg.consensusState).toBe(CircuitState.OPEN)
    expect(agg.totalNodes).toBe(2)
    expect(agg.healthScore).toBe(0.25)
    expect(agg.nodeStates).toEqual({ a: CircuitState.OPEN, b: CircuitState.CLOSED })
  })

  it('getAggregatedState returns CLOSED/empty defaults when fetch throws', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockRejectedValueOnce(new Error('network down'))

    const client = new DistributedCircuitBreakerClient('http://coordinator')
    const agg = await client.getAggregatedState('svc-agg-fail')

    expect(agg).toEqual({
      service: 'svc-agg-fail',
      consensusState: CircuitState.CLOSED,
      totalNodes: 0,
      healthScore: 0,
      nodeStates: {},
    })
  })
})