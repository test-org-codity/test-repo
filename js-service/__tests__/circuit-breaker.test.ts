import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals'
import {
  CircuitBreaker,
  CircuitBreakerOpenError,
  CircuitState,
  DistributedCircuitBreakerClient,
  withCircuitBreaker,
} from '../src/circuit-breaker'

describe('CircuitBreaker', () => {
  afterEach(() => {
    jest.clearAllMocks()
    jest.useRealTimers()
  })

  it('execute resolves and updates metrics on success', async () => {
    const breaker = new CircuitBreaker('svc-success')
    const result = await breaker.execute(async () => 'ok')

    expect(result).toBe('ok')
    const info = breaker.getHealthInfo()
    expect(info.state).toBe(CircuitState.CLOSED)
    expect(info.metrics.totalCalls).toBe(1)
    expect(info.metrics.successfulCalls).toBe(1)
    expect(info.metrics.failedCalls).toBe(0)
    expect(info.metrics.lastSuccessTime).not.toBeNull()
    expect(typeof info.metrics.averageResponseTimeMs).toBe('number')
  })

  it('execute rejects and updates metrics on failure, remains CLOSED below threshold', async () => {
    const breaker = new CircuitBreaker('svc-fail', { failureThreshold: 3 })
    await expect(
      breaker.execute(async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')

    const info = breaker.getHealthInfo()
    expect(info.state).toBe(CircuitState.CLOSED)
    expect(info.metrics.totalCalls).toBe(1)
    expect(info.metrics.failedCalls).toBe(1)
    expect(info.metrics.lastFailureTime).not.toBeNull()
  })

  it('transitions to OPEN after reaching failureThreshold', async () => {
    const breaker = new CircuitBreaker('svc-open', { failureThreshold: 2 })
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
    expect(breaker.getHealthInfo().metrics.stateTransitions).toBe(1)
  })

  it('rejects when OPEN without fallback and increments rejectedCalls', async () => {
    const breaker = new CircuitBreaker('svc-open-no-fallback', { failureThreshold: 1, timeoutMs: 1000 })
    await expect(
      breaker.execute(async () => {
        throw new Error('fail')
      })
    ).rejects.toThrow('fail')

    await expect(
      breaker.execute(async () => 'should-not-run')
    ).rejects.toBeInstanceOf(CircuitBreakerOpenError)

    const info = breaker.getHealthInfo()
    expect(info.metrics.rejectedCalls).toBe(1)
    expect(info.metrics.totalCalls).toBe(1)
  })

  it('OPEN with fallback returns fallback and increments rejectedCalls', async () => {
    const breaker = new CircuitBreaker('svc-open-fallback', { failureThreshold: 1, timeoutMs: 1000 })
    await expect(
      breaker.execute(async () => {
        throw new Error('fail')
      })
    ).rejects.toThrow('fail')

    const result = await breaker.execute(async () => 'nope', async () => 'fallback')
    expect(result).toBe('fallback')

    const info = breaker.getHealthInfo()
    expect(info.metrics.rejectedCalls).toBe(1)
    expect(info.metrics.totalCalls).toBe(1)
  })

  it('OPEN error message includes name and remaining time', async () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date(0))
    const breaker = new CircuitBreaker('svc-open-err-msg', { failureThreshold: 1, timeoutMs: 1000 })

    await expect(
      breaker.execute(async () => {
        throw new Error('fail')
      })
    ).rejects.toThrow()

    jest.setSystemTime(new Date(100))
    await expect(
      breaker.execute(async () => 'x')
    ).rejects.toThrowError(new RegExp(`Circuit breaker 'svc-open-err-msg' is open\\. Retry after 900ms`))
  })

  it('transitions to HALF_OPEN after timeout from OPEN on getState()', async () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date(0))
    const breaker = new CircuitBreaker('svc-half-open', { failureThreshold: 1, timeoutMs: 500 })

    await expect(
      breaker.execute(async () => {
        throw new Error('fail')
      })
    ).rejects.toThrow()

    expect(breaker.getState()).toBe(CircuitState.OPEN)

    jest.setSystemTime(new Date(600))
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)
  })

  it('HALF_OPEN allows limited calls and rejects further calls', async () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date(0))
    const breaker = new CircuitBreaker('svc-half-open-limit', {
      failureThreshold: 1,
      timeoutMs: 100,
      halfOpenMaxCalls: 2,
      successThreshold: 10,
    })

    await expect(
      breaker.execute(async () => {
        throw new Error('fail')
      })
    ).rejects.toThrow()

    jest.setSystemTime(new Date(200))
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)

    const r1 = await breaker.execute(async () => 'ok1')
    const r2 = await breaker.execute(async () => 'ok2')
    expect(r1).toBe('ok1')
    expect(r2).toBe('ok2')

    const r3 = await breaker.execute(async () => 'no', async () => 'fb')
    expect(r3).toBe('fb')

    const info = breaker.getHealthInfo()
    expect(info.state).toBe(CircuitState.HALF_OPEN)
    expect(info.metrics.rejectedCalls).toBe(1)
  })

  it('HALF_OPEN closes after reaching successThreshold', async () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date(0))
    const breaker = new CircuitBreaker('svc-half-open-close', {
      failureThreshold: 1,
      timeoutMs: 100,
      halfOpenMaxCalls: 5,
      successThreshold: 2,
    })

    await expect(
      breaker.execute(async () => {
        throw new Error('fail')
      })
    ).rejects.toThrow()

    jest.setSystemTime(new Date(200))
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)

    await breaker.execute(async () => 'ok1')
    await breaker.execute(async () => 'ok2')

    expect(breaker.getState()).toBe(CircuitState.CLOSED)
    const info = breaker.getHealthInfo()
    expect(info.failureCount).toBe(0)
    expect(info.metrics.stateTransitions).toBe(2) // OPEN -> HALF_OPEN -> CLOSED
  })

  it('HALF_OPEN failure transitions back to OPEN', async () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date(0))
    const breaker = new CircuitBreaker('svc-half-open-failure', {
      failureThreshold: 1,
      timeoutMs: 100,
      halfOpenMaxCalls: 3,
      successThreshold: 5,
    })

    await expect(
      breaker.execute(async () => {
        throw new Error('fail')
      })
    ).rejects.toThrow()

    jest.setSystemTime(new Date(200))
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)

    await expect(
      breaker.execute(async () => {
        throw new Error('half-open-fail')
      })
    ).rejects.toThrow('half-open-fail')

    expect(breaker.getState()).toBe(CircuitState.OPEN)
  })

  it('sliding window failure rate triggers OPEN before failureThreshold', async () => {
    const breaker = new CircuitBreaker('svc-sliding', {
      failureThreshold: 100,
      slidingWindowSize: 4,
      failureRateThreshold: 0.5,
    })

    // 3 consecutive failures -> window has [false,false,false,true] => 75% failures
    await expect(breaker.execute(async () => { throw new Error('f1') })).rejects.toThrow()
    await expect(breaker.execute(async () => { throw new Error('f2') })).rejects.toThrow()
    await expect(breaker.execute(async () => { throw new Error('f3') })).rejects.toThrow()

    expect(breaker.getState()).toBe(CircuitState.OPEN)
  })

  it('executeSync handles success and updates metrics', () => {
    const breaker = new CircuitBreaker('svc-sync-success')
    const result = breaker.executeSync(() => 42)
    expect(result).toBe(42)
    const info = breaker.getHealthInfo()
    expect(info.metrics.totalCalls).toBe(1)
    expect(info.metrics.successfulCalls).toBe(1)
    expect(info.state).toBe(CircuitState.CLOSED)
  })

  it('executeSync throws on failure and updates metrics', () => {
    const breaker = new CircuitBreaker('svc-sync-failure', { failureThreshold: 5 })
    expect(() => breaker.executeSync(() => { throw new Error('sync-fail') })).toThrow('sync-fail')
    const info = breaker.getHealthInfo()
    expect(info.metrics.failedCalls).toBe(1)
    expect(info.state).toBe(CircuitState.CLOSED)
  })

  it('getHealthInfo returns correct structure and failureRate', async () => {
    const breaker = new CircuitBreaker('svc-health', {
      slidingWindowSize: 4,
      failureThreshold: 10,
      failureRateThreshold: 0.9,
    })

    await breaker.execute(async () => 's1')
    await expect(breaker.execute(async () => { throw new Error('f1') })).rejects.toThrow()
    await breaker.execute(async () => 's2')
    await expect(breaker.execute(async () => { throw new Error('f2') })).rejects.toThrow()

    const info = breaker.getHealthInfo()
    expect(info.name).toBe('svc-health')
    expect(info.state).toBe(CircuitState.CLOSED)
    expect(info.failureRate).toBeCloseTo(0.5, 5)
    expect(info.config.failureThreshold).toBeDefined()
    expect(info.config.successThreshold).toBeDefined()
    expect(info.config.timeoutMs).toBeDefined()
    // Ensure only partial config exposed
    expect(Object.keys(info.config).sort()).toEqual(['failureThreshold', 'successThreshold', 'timeoutMs'].sort())
  })

  it('getOrCreate returns same instance for same name and registry contains it', () => {
    const b1 = CircuitBreaker.getOrCreate('shared', { failureThreshold: 2 })
    const b2 = CircuitBreaker.getOrCreate('shared', { failureThreshold: 10 })
    expect(b2).toBe(b1)

    const registry = CircuitBreaker.getRegistry()
    expect(registry.has('shared')).toBe(true)

    // Returned registry is a copy; modifications don't affect internal
    registry.delete('shared')
    const registry2 = CircuitBreaker.getRegistry()
    expect(registry2.has('shared')).toBe(true)
  })
})

describe('DistributedCircuitBreakerClient', () => {
  const g: any = global
  beforeEach(() => {
    g.fetch = jest.fn().mockResolvedValue({
      json: jest.fn().mockResolvedValue({ ok: true }),
    })
  })
  afterEach(() => {
    jest.clearAllMocks()
    jest.useRealTimers()
  })

  it('register sends registration payload', async () => {
    const client = new DistributedCircuitBreakerClient('http://coord')
    const breaker = new CircuitBreaker('svc-register', { failureThreshold: 7, successThreshold: 4 })
    client.register(breaker)

    await Promise.resolve()

    expect(g.fetch).toHaveBeenCalled()
    const [url, init] = (g.fetch as jest.Mock).mock.calls[0]
    expect(url).toBe('http://coord/circuit-breakers/register')
    const body = JSON.parse((init as any).body)
    expect(body.service).toBe('svc-register')
    expect(body.failure_threshold).toBe(7)
    expect(body.success_threshold).toBe(4)
    expect((init as any).method).toBe('POST')
  })

  it('getAggregatedState returns parsed data on success', async () => {
    const aggregated = {
      service: 'svc-agg',
      consensusState: CircuitState.OPEN,
      totalNodes: 3,
      healthScore: 0.8,
      nodeStates: { a: CircuitState.OPEN, b: CircuitState.CLOSED },
    }
    ;(global as any).fetch = jest.fn().mockResolvedValue({
      json: jest.fn().mockResolvedValue(aggregated),
    })

    const client = new DistributedCircuitBreakerClient('http://coord')
    const result = await client.getAggregatedState('svc-agg')
    expect(result).toEqual(aggregated)
  })

  it('getAggregatedState returns default on error', async () => {
    ;(global as any).fetch = jest.fn().mockRejectedValue(new Error('network'))
    const client = new DistributedCircuitBreakerClient('http://coord')
    const result = await client.getAggregatedState('svc-default')
    expect(result.service).toBe('svc-default')
    expect(result.consensusState).toBe(CircuitState.CLOSED)
    expect(result.totalNodes).toBe(0)
    expect(result.nodeStates).toEqual({})
  })

  it('startSync reports state at intervals and stopSync stops reporting', async () => {
    jest.useFakeTimers()
    const fetchMock = jest.fn().mockResolvedValue({ json: jest.fn() })
    ;(global as any).fetch = fetchMock

    const client = new DistributedCircuitBreakerClient('http://coord', 1000)
    const b1 = new CircuitBreaker('svc-sync-1')
    const b2 = new CircuitBreaker('svc-sync-2')
    client.register(b1)
    client.register(b2)
    await Promise.resolve()
    fetchMock.mockClear()

    client.startSync()

    jest.advanceTimersByTime(1000)
    expect(fetchMock).toHaveBeenCalled()
    const stateCalls1 = fetchMock.mock.calls.filter(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('/circuit-breakers/state')
    )
    expect(stateCalls1.length).toBe(2)

    fetchMock.mockClear()
    jest.advanceTimersByTime(1000)
    const stateCalls2 = fetchMock.mock.calls.filter(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('/circuit-breakers/state')
    )
    expect(stateCalls2.length).toBe(2)

    fetchMock.mockClear()
    client.stopSync()
    jest.advanceTimersByTime(2000)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('withCircuitBreaker decorator', () => {
  afterEach(() => {
    jest.clearAllMocks()
  })

  it('wraps method to execute via CircuitBreaker and returns original result', async () => {
    const executeMock = jest.fn(async (fn: () => any) => fn())
    const getOrCreateSpy = jest.spyOn(CircuitBreaker, 'getOrCreate').mockReturnValue({
      name: 'decorated',
      execute: executeMock as any,
      executeSync: jest.fn(),
      getState: jest.fn(),
      getHealthInfo: jest.fn(),
    } as unknown as CircuitBreaker)

    class Service {
      value = 10
    }
    const svc = new Service()
    const target: any = svc
    Object.defineProperty(target, 'sum', {
      value: function (a: number, b: number) {
        return a + b + this.value
      },
      writable: true,
      configurable: true,
    })

    const decorator = withCircuitBreaker('decorated')
    const desc = Object.getOwnPropertyDescriptor(target, 'sum')!
    const newDesc = decorator(target, 'sum', desc)!
    Object.defineProperty(target, 'sum', newDesc)

    const result = await (target.sum as any)(1, 2)
    expect(result).toBe(13)
    expect(getOrCreateSpy).toHaveBeenCalledWith('decorated', undefined)
    expect(executeMock).toHaveBeenCalled()
  })

  it('propagates errors when original method throws inside decorator', async () => {
    const executeMock = jest.fn(async (fn: () => any) => fn())
    jest.spyOn(CircuitBreaker, 'getOrCreate').mockReturnValue({
      name: 'decorated-error',
      execute: executeMock as any,
      executeSync: jest.fn(),
      getState: jest.fn(),
      getHealthInfo: jest.fn(),
    } as unknown as CircuitBreaker)

    const target: any = {}
    Object.defineProperty(target, 'fail', {
      value: function () {
        throw new Error('method-failed')
      },
      writable: true,
      configurable: true,
    })

    const decorator = withCircuitBreaker('decorated-error')
    const desc = Object.getOwnPropertyDescriptor(target, 'fail')!
    const newDesc = decorator(target, 'fail', desc)!
    Object.defineProperty(target, 'fail', newDesc)

    await expect((target.fail as any)()).rejects.toThrow('method-failed')
  })
})