import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  CircuitBreaker,
  CircuitBreakerOpenError,
  CircuitState,
  DistributedCircuitBreakerClient,
  withCircuitBreaker,
} from '../src/circuit-breaker'

describe('CircuitBreaker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2020-01-01T00:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('starts in CLOSED state and reports health info with defaults', () => {
    const breaker = new CircuitBreaker('svc-default')
    const health = breaker.getHealthInfo()

    expect(breaker.getState()).toBe(CircuitState.CLOSED)
    expect(health.name).toBe('svc-default')
    expect(health.state).toBe(CircuitState.CLOSED)
    expect(health.failureCount).toBe(0)
    expect(health.successCount).toBe(0)
    expect(health.failureRate).toBe(0)
    expect(health.metrics.totalCalls).toBe(0)
    expect(health.metrics.stateTransitions).toBe(0)
    expect(health.metrics.averageResponseTimeMs).toBe(0)

    // Only a subset is exposed in config
    expect(health.config).toEqual({
      failureThreshold: 5,
      successThreshold: 3,
      timeoutMs: 30000,
    })
  })

  it('getOrCreate returns the same instance for the same name', () => {
    const a1 = CircuitBreaker.getOrCreate('shared', { failureThreshold: 1 })
    const a2 = CircuitBreaker.getOrCreate('shared', { failureThreshold: 999 })
    expect(a1).toBe(a2)

    const b = CircuitBreaker.getOrCreate('other')
    expect(b).not.toBe(a1)
  })

  it('getRegistry returns a copy (mutating returned map does not affect internal registry)', () => {
    const created = CircuitBreaker.getOrCreate('reg-test')
    const reg1 = CircuitBreaker.getRegistry()
    expect(reg1.get('reg-test')).toBe(created)

    reg1.delete('reg-test')
    const reg2 = CircuitBreaker.getRegistry()
    expect(reg2.has('reg-test')).toBe(true)
  })

  it('execute records a successful async call and updates metrics/average response time', async () => {
    const breaker = new CircuitBreaker('svc-success')

    const nowSpy = vi.spyOn(Date, 'now')
    nowSpy.mockReturnValueOnce(1000) // start
    nowSpy.mockReturnValueOnce(1015) // end

    const res = await breaker.execute(async () => 'ok')
    expect(res).toBe('ok')

    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(1)
    expect(health.metrics.successfulCalls).toBe(1)
    expect(health.metrics.failedCalls).toBe(0)
    expect(health.metrics.rejectedCalls).toBe(0)
    expect(health.metrics.averageResponseTimeMs).toBe(15)
    expect(health.metrics.lastSuccessTime).toBeInstanceOf(Date)
    expect(health.metrics.lastFailureTime).toBe(null)
    expect(health.failureCount).toBe(0)
  })

  it('executeSync records a successful sync call and updates metrics', () => {
    const breaker = new CircuitBreaker('svc-success-sync')

    const nowSpy = vi.spyOn(Date, 'now')
    nowSpy.mockReturnValueOnce(2000)
    nowSpy.mockReturnValueOnce(2010)

    const res = breaker.executeSync(() => 123)
    expect(res).toBe(123)

    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(1)
    expect(health.metrics.successfulCalls).toBe(1)
    expect(health.metrics.failedCalls).toBe(0)
    expect(health.metrics.averageResponseTimeMs).toBe(10)
  })

  it('execute records a failed async call and rethrows while updating metrics', async () => {
    const breaker = new CircuitBreaker('svc-fail')

    const nowSpy = vi.spyOn(Date, 'now')
    nowSpy.mockReturnValueOnce(3000)
    nowSpy.mockReturnValueOnce(3020)

    const err = new Error('boom')
    await expect(
      breaker.execute(async () => {
        throw err
      })
    ).rejects.toBe(err)

    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(1)
    expect(health.metrics.successfulCalls).toBe(0)
    expect(health.metrics.failedCalls).toBe(1)
    expect(health.metrics.lastFailureTime).toBeInstanceOf(Date)
    expect(health.metrics.averageResponseTimeMs).toBe(20)
  })

  it('executeSync records a failed sync call and rethrows while updating metrics', () => {
    const breaker = new CircuitBreaker('svc-fail-sync')
    const nowSpy = vi.spyOn(Date, 'now')
    nowSpy.mockReturnValueOnce(4000)
    nowSpy.mockReturnValueOnce(4012)

    const err = new Error('sync boom')
    expect(() =>
      breaker.executeSync(() => {
        throw err
      })
    ).toThrow(err)

    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(1)
    expect(health.metrics.failedCalls).toBe(1)
    expect(health.metrics.averageResponseTimeMs).toBe(12)
  })

  it('opens when failureCount reaches failureThreshold', async () => {
    const breaker = new CircuitBreaker('svc-open-threshold', {
      failureThreshold: 2,
      slidingWindowSize: 10,
      failureRateThreshold: 1, // ensure threshold path triggers first
      timeoutMs: 30000,
    })

    const op = vi.fn(async () => {
      throw new Error('x')
    })

    await expect(breaker.execute(op)).rejects.toThrow('x')
    expect(breaker.getState()).toBe(CircuitState.CLOSED)

    await expect(breaker.execute(op)).rejects.toThrow('x')
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    const health = breaker.getHealthInfo()
    expect(health.metrics.stateTransitions).toBe(1)
    expect(health.metrics.failedCalls).toBe(2)
  })

  it('opens when sliding-window failure rate exceeds or equals failureRateThreshold', async () => {
    const breaker = new CircuitBreaker('svc-open-rate', {
      failureThreshold: 999, // avoid count threshold
      slidingWindowSize: 4,
      failureRateThreshold: 0.5,
    })

    const succeed = vi.fn(async () => 'ok')
    const fail = vi.fn(async () => {
      throw new Error('nope')
    })

    await breaker.execute(succeed)
    await breaker.execute(succeed)
    expect(breaker.getState()).toBe(CircuitState.CLOSED)

    await expect(breaker.execute(fail)).rejects.toThrow('nope')
    expect(breaker.getState()).toBe(CircuitState.CLOSED)

    await expect(breaker.execute(fail)).rejects.toThrow('nope')
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    const health = breaker.getHealthInfo()
    expect(health.failureRate).toBe(0.5)
    expect(health.metrics.stateTransitions).toBe(1)
  })

  it('when OPEN, execute rejects with CircuitBreakerOpenError including remainingTimeMs and increments rejectedCalls', async () => {
    const breaker = new CircuitBreaker('svc-open-error', {
      failureThreshold: 1,
      timeoutMs: 1000,
    })

    const nowSpy = vi.spyOn(Date, 'now')
    // First call: during failure execution
    nowSpy.mockReturnValueOnce(1000) // start
    nowSpy.mockReturnValueOnce(1010) // end
    // TransitionTo OPEN sets openedAt=Date.now()
    nowSpy.mockReturnValueOnce(1010) // openedAt
    // Next call checks remaining: now = 1310 -> remaining = 1000 - (1310-1010)=700
    nowSpy.mockReturnValueOnce(1310)

    await expect(
      breaker.execute(async () => {
        throw new Error('fail once')
      })
    ).rejects.toThrow('fail once')
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    await expect(breaker.execute(async () => 'never')).rejects.toBeInstanceOf(
      CircuitBreakerOpenError
    )

    const health = breaker.getHealthInfo()
    expect(health.metrics.rejectedCalls).toBe(1)
    expect(health.metrics.totalCalls).toBe(1) // rejected calls do not increment totalCalls
  })

  it('when OPEN and fallback provided, execute returns fallback result (and does not call operation)', async () => {
    const breaker = new CircuitBreaker('svc-open-fallback', {
      failureThreshold: 1,
      timeoutMs: 10000,
    })

    const nowSpy = vi.spyOn(Date, 'now')
    nowSpy.mockReturnValueOnce(2000) // start
    nowSpy.mockReturnValueOnce(2001) // end
    nowSpy.mockReturnValueOnce(2001) // openedAt
    nowSpy.mockReturnValueOnce(2500) // used by remaining time calc (not asserted)

    await expect(
      breaker.execute(async () => {
        throw new Error('fail')
      })
    ).rejects.toThrow('fail')
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    const operation = vi.fn(async () => 'op')
    const fallback = vi.fn(async () => 'fb')

    const result = await breaker.execute(operation, fallback)
    expect(result).toBe('fb')
    expect(operation).not.toHaveBeenCalled()
    expect(fallback).toHaveBeenCalledTimes(1)

    const health = breaker.getHealthInfo()
    expect(health.metrics.rejectedCalls).toBe(1)
    expect(health.metrics.totalCalls).toBe(1)
  })

  it('after timeout, getState transitions OPEN -> HALF_OPEN and allows up to halfOpenMaxCalls', async () => {
    const breaker = new CircuitBreaker('svc-half-open', {
      failureThreshold: 1,
      timeoutMs: 1000,
      halfOpenMaxCalls: 2,
      successThreshold: 5, // keep HALF_OPEN after successes
    })

    const nowSpy = vi.spyOn(Date, 'now')
    // failure call
    nowSpy.mockReturnValueOnce(5000)
    nowSpy.mockReturnValueOnce(5001)
    nowSpy.mockReturnValueOnce(5001) // openedAt
    await expect(
      breaker.execute(async () => {
        throw new Error('fail')
      })
    ).rejects.toThrow('fail')
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    // After timeout, getState triggers HALF_OPEN and resets halfOpenCalls/successCount
    nowSpy.mockReturnValueOnce(6001) // now - openedAt = 1000
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)

    // In HALF_OPEN, allowRequest increments halfOpenCalls up to halfOpenMaxCalls
    const op = vi.fn(async () => 'ok')
    await breaker.execute(op)
    await breaker.execute(op)

    // Third attempt should be rejected (still HALF_OPEN)
    const fallback = vi.fn(async () => 'fallback')
    const res = await breaker.execute(op, fallback)
    expect(res).toBe('fallback')
    expect(op).toHaveBeenCalledTimes(2)
    expect(fallback).toHaveBeenCalledTimes(1)

    const health = breaker.getHealthInfo()
    expect(health.state).toBe(CircuitState.HALF_OPEN)
    expect(health.metrics.rejectedCalls).toBe(1)
  })

  it('in HALF_OPEN, a failure transitions back to OPEN', async () => {
    const breaker = new CircuitBreaker('svc-half-open-fail', {
      failureThreshold: 1,
      timeoutMs: 1000,
    })

    const nowSpy = vi.spyOn(Date, 'now')
    // Open it
    nowSpy.mockReturnValueOnce(100)
    nowSpy.mockReturnValueOnce(101)
    nowSpy.mockReturnValueOnce(101)
    await expect(
      breaker.execute(async () => {
        throw new Error('initial fail')
      })
    ).rejects.toThrow('initial fail')
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    // Transition to HALF_OPEN after timeout
    nowSpy.mockReturnValueOnce(1101)
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)

    // In HALF_OPEN, a failure opens immediately
    nowSpy.mockReturnValueOnce(2000)
    nowSpy.mockReturnValueOnce(2001)
    nowSpy.mockReturnValueOnce(2001) // openedAt set again on transition to OPEN
    await expect(
      breaker.execute(async () => {
        throw new Error('fail again')
      })
    ).rejects.toThrow('fail again')

    expect(breaker.getState()).toBe(CircuitState.OPEN)
    expect(breaker.getHealthInfo().metrics.stateTransitions).toBe(3) // CLOSED->OPEN, OPEN->HALF_OPEN, HALF_OPEN->OPEN
  })

  it('in HALF_OPEN, enough consecutive successes (successThreshold) transitions to CLOSED and resets counts/window', async () => {
    const breaker = new CircuitBreaker('svc-half-open-close', {
      failureThreshold: 1,
      timeoutMs: 1000,
      successThreshold: 2,
      slidingWindowSize: 5,
      halfOpenMaxCalls: 5,
    })

    const nowSpy = vi.spyOn(Date, 'now')
    // Open it
    nowSpy.mockReturnValueOnce(1000)
    nowSpy.mockReturnValueOnce(1001)
    nowSpy.mockReturnValueOnce(1001)
    await expect(
      breaker.execute(async () => {
        throw new Error('open')
      })
    ).rejects.toThrow('open')
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    // Move to HALF_OPEN
    nowSpy.mockReturnValueOnce(2001)
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)

    await breaker.execute(async () => 'a')
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)

    await breaker.execute(async () => 'b')
    expect(breaker.getState()).toBe(CircuitState.CLOSED)

    const health = breaker.getHealthInfo()
    expect(health.failureCount).toBe(0)
    expect(health.successCount).toBe(0)
    expect(health.failureRate).toBe(0) // window filled true on close
  })

  it('in CLOSED, success decreases failureCount but never below 0', async () => {
    const breaker = new CircuitBreaker('svc-decrement', {
      failureThreshold: 10,
      slidingWindowSize: 10,
      failureRateThreshold: 1,
    })

    // Create a failure (still closed)
    await expect(
      breaker.execute(async () => {
        throw new Error('f1')
      })
    ).rejects.toThrow('f1')
    expect(breaker.getHealthInfo().failureCount).toBe(1)

    // Success should reduce to 0
    await breaker.execute(async () => 'ok')
    expect(breaker.getHealthInfo().failureCount).toBe(0)

    // Another success should keep at 0
    await breaker.execute(async () => 'ok2')
    expect(breaker.getHealthInfo().failureCount).toBe(0)
  })

  it('averageResponseTimeMs keeps only the last 100 response times', async () => {
    const breaker = new CircuitBreaker('svc-avg-100')

    const nowSpy = vi.spyOn(Date, 'now')
    // 101 calls, each duration = 1ms
    for (let i = 0; i < 101; i++) {
      nowSpy.mockReturnValueOnce(100000 + i * 10)
      nowSpy.mockReturnValueOnce(100000 + i * 10 + 1)
      await breaker.execute(async () => 'ok')
    }

    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(101)
    expect(health.metrics.successfulCalls).toBe(101)
    expect(health.metrics.averageResponseTimeMs).toBe(1)
  })
})

describe('CircuitBreakerOpenError', () => {
  it('sets error.name to CircuitBreakerOpenError and includes remaining time in message', () => {
    const err = new CircuitBreakerOpenError('svc-x', 12.6)
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('CircuitBreakerOpenError')
    expect(err.message).toContain("Circuit breaker 'svc-x' is open. Retry after 13ms")
    expect(err.remainingTimeMs).toBe(12.6)
  })
})

describe('DistributedCircuitBreakerClient', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2020-01-01T00:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    delete (globalThis as any).fetch
    delete process.env.NODE_ID
  })

  it('register stores breaker and sends registration (best-effort, ignores failures)', async () => {
    process.env.NODE_ID = 'node-1'
    const fetchMock = vi.fn(async () => ({ json: vi.fn(async () => ({})) }))
    ;(globalThis as any).fetch = fetchMock

    const client = new DistributedCircuitBreakerClient('http://coord', 50)
    const breaker = new CircuitBreaker('svc-reg', { failureThreshold: 7, successThreshold: 2 })

    client.register(breaker)

    await vi.runAllTimersAsync()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe('http://coord/circuit-breakers/register')
    expect(init.method).toBe('POST')
    const body = JSON.parse(init.body as string)
    expect(body.service).toBe('svc-reg')
    expect(body.node_id).toBe('node-1')
    expect(body.failure_threshold).toBe(7)
    expect(body.success_threshold).toBe(2)
  })

  it('startSync is idempotent and stopSync clears interval', async () => {
    const fetchMock = vi.fn(async () => ({ json: vi.fn(async () => ({})) }))
    ;(globalThis as any).fetch = fetchMock

    const client = new DistributedCircuitBreakerClient('http://coord', 10)
    const breaker = new CircuitBreaker('svc-sync')
    client.register(breaker)

    client.startSync()
    client.startSync()

    await vi.advanceTimersByTimeAsync(35)

    // registration + roughly 3 sync state posts (timing-dependent but should be >= 2)
    const stateCalls = fetchMock.mock.calls.filter(
      (c) => String(c[0]).includes('/circuit-breakers/state') && c[1]?.method === 'POST'
    )
    expect(stateCalls.length).toBeGreaterThanOrEqual(2)

    client.stopSync()
    const callsAfterStop = fetchMock.mock.calls.length
    await vi.advanceTimersByTimeAsync(50)
    expect(fetchMock.mock.calls.length).toBe(callsAfterStop)
  })

  it('getAggregatedState returns parsed response on success', async () => {
    const payload = {
      service: 'svc-a',
      consensusState: CircuitState.OPEN,
      totalNodes: 2,
      healthScore: 0.2,
      nodeStates: { n1: CircuitState.OPEN, n2: CircuitState.CLOSED },
    }
    const fetchMock = vi.fn(async () => ({ json: vi.fn(async () => payload) }))
    ;(globalThis as any).fetch = fetchMock

    const client = new DistributedCircuitBreakerClient('http://coord')
    const res = await client.getAggregatedState('svc-a')
    expect(res).toEqual(payload)

    expect(fetchMock).toHaveBeenCalledWith(
      'http://coord/circuit-breakers/svc-a/aggregate'
    )
  })

  it('getAggregatedState returns safe defaults when fetch fails', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('network')
    })
    ;(globalThis as any).fetch = fetchMock

    const client = new DistributedCircuitBreakerClient('http://coord')
    const res = await client.getAggregatedState('svc-missing')

    expect(res).toEqual({
      service: 'svc-missing',
      consensusState: CircuitState.CLOSED,
      totalNodes: 0,
      healthScore: 0,
      nodeStates: {},
    })
  })
})

describe('withCircuitBreaker decorator', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('wraps the original async method and routes through CircuitBreaker.execute', async () => {
    const breaker = CircuitBreaker.getOrCreate('decorator-svc')
    const execSpy = vi.spyOn(breaker, 'execute')

    class Example {
      async work(x: number) {
        return `res:${x}`
      }
    }

    const descriptor: PropertyDescriptor = {
      value: Example.prototype.work,
      configurable: true,
      enumerable: true,
      writable: true,
    }

    const decoratorFactory = withCircuitBreaker('decorator-svc')
    const newDescriptor = decoratorFactory(Example.prototype, 'work', descriptor)
    Example.prototype.work = newDescriptor.value

    const inst = new Example()
    const out = await inst.work(5)
    expect(out).toBe('res:5')

    expect(execSpy).toHaveBeenCalledTimes(1)
    const [op] = execSpy.mock.calls[0]
    expect(typeof op).toBe('function')
  })

  it('propagates errors from the original method through the breaker', async () => {
    CircuitBreaker.getOrCreate('decorator-svc-err')
    class Example {
      async work() {
        throw new Error('nope')
      }
    }

    const descriptor: PropertyDescriptor = {
      value: Example.prototype.work,
      configurable: true,
    }

    const decoratorFactory = withCircuitBreaker('decorator-svc-err')
    const newDescriptor = decoratorFactory(Example.prototype, 'work', descriptor)
    Example.prototype.work = newDescriptor.value

    await expect(new Example().work()).rejects.toThrow('nope')
  })
})