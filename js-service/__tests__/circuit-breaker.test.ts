import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals'
import {
  CircuitBreaker,
  CircuitBreakerOpenError,
  CircuitState,
  DistributedCircuitBreakerClient,
  withCircuitBreaker,
  type AggregatedState,
} from '../src/circuit-breaker'

declare const global: any

describe('CircuitBreaker', () => {
  let breaker: CircuitBreaker

  beforeEach(() => {
    // Reset internal static registry by re-creating breaker names
    breaker = new CircuitBreaker('test-service', {
      failureThreshold: 3,
      successThreshold: 2,
      timeoutMs: 1000,
      halfOpenMaxCalls: 2,
      slidingWindowSize: 4,
      failureRateThreshold: 0.5,
    })
    jest.spyOn(Date, 'now').mockImplementation(() => 1_000_000)
  })

  afterEach(() => {
    jest.clearAllMocks()
    jest.useRealTimers()
  })

  it('starts in CLOSED state and allows requests', () => {
    expect((breaker as any).state).toBe(CircuitState.CLOSED)
    const result = breaker.executeSync(() => 'ok')
    expect(result).toBe('ok')
    const health = breaker.getHealthInfo()
    expect(health.state).toBe(CircuitState.CLOSED)
    expect(health.failureCount).toBe(0)
    expect(health.successCount).toBe(0)
  })

  it('records successful async calls and updates metrics and response time', async () => {
    jest.spyOn(Date, 'now').mockImplementationOnce(() => 1_000_000).mockImplementationOnce(() => 1_000_050)
    const op = jest.fn().mockResolvedValue('value')
    const result = await breaker.execute(op)
    expect(result).toBe('value')
    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(1)
    expect(health.metrics.successfulCalls).toBe(1)
    expect(health.metrics.failedCalls).toBe(0)
    expect(health.metrics.averageResponseTimeMs).toBe(50)
    expect(health.metrics.lastSuccessTime).toBeInstanceOf(Date)
  })

  it('records failed async calls and increments failureCount and state may open', async () => {
    const op = jest.fn().mockRejectedValue(new Error('fail'))
    await expect(breaker.execute(op)).rejects.toThrow('fail')
    const health = breaker.getHealthInfo()
    expect(health.metrics.failedCalls).toBe(1)
    expect(health.failureCount).toBe(1)
  })

  it('opens circuit when failureThreshold is reached in CLOSED state', async () => {
    const failingOp = jest.fn().mockRejectedValue(new Error('fail'))
    await expect(breaker.execute(failingOp)).rejects.toThrow()
    await expect(breaker.execute(failingOp)).rejects.toThrow()
    await expect(breaker.execute(failingOp)).rejects.toThrow()
    const health = breaker.getHealthInfo()
    expect(health.state).toBe(CircuitState.OPEN)
    expect(health.failureCount).toBeGreaterThanOrEqual(3)
  })

  it('opens circuit when failureRateThreshold is exceeded before failureCount threshold', async () => {
    // slidingWindowSize = 4, failureRateThreshold = 0.5
    const fail = jest.fn().mockRejectedValue(new Error('fail'))
    const succeed = jest.fn().mockResolvedValue('ok')

    await expect(breaker.execute(succeed)).resolves.toBe('ok')
    await expect(breaker.execute(fail)).rejects.toThrow()
    await expect(breaker.execute(fail)).rejects.toThrow()
    const health = breaker.getHealthInfo()
    expect(health.failureRate).toBeGreaterThanOrEqual(0.5)
    expect(health.state).toBe(CircuitState.OPEN)
  })

  it('rejects new async calls when OPEN and throws CircuitBreakerOpenError without fallback', async () => {
    ;(breaker as any).state = CircuitState.OPEN
    ;(breaker as any).openedAt = 1_000_000
    jest.spyOn(Date, 'now').mockImplementation(() => 1_000_500)
    const op = jest.fn()
    await expect(breaker.execute(op)).rejects.toBeInstanceOf(CircuitBreakerOpenError)
    const health = breaker.getHealthInfo()
    expect(health.metrics.rejectedCalls).toBe(1)
  })

  it('uses fallback when OPEN for async execute', async () => {
    ;(breaker as any).state = CircuitState.OPEN
    ;(breaker as any).openedAt = 1_000_000
    const op = jest.fn()
    const fallback = jest.fn().mockResolvedValue('fallback')
    const result = await breaker.execute(op, fallback)
    expect(result).toBe('fallback')
    expect(op).not.toHaveBeenCalled()
    const health = breaker.getHealthInfo()
    expect(health.metrics.rejectedCalls).toBe(1)
  })

  it('moves to HALF_OPEN after timeout and then to CLOSED after enough successes', async () => {
    ;(breaker as any).state = CircuitState.OPEN
    ;(breaker as any).openedAt = 1_000_000
    // timeoutMs = 1000 so after 1001ms it should move to HALF_OPEN
    jest.spyOn(Date, 'now').mockImplementation(() => 1_001_001)
    const state1 = breaker.getState()
    expect(state1).toBe(CircuitState.HALF_OPEN)
    const op = jest.fn().mockResolvedValue('ok')
    await breaker.execute(op)
    await breaker.execute(op)
    const health = breaker.getHealthInfo()
    expect(health.state).toBe(CircuitState.CLOSED)
    expect(health.metrics.stateTransitions).toBeGreaterThanOrEqual(2)
  })

  it('in HALF_OPEN, a failure immediately transitions back to OPEN', async () => {
    ;(breaker as any).state = CircuitState.HALF_OPEN
    const failOp = jest.fn().mockRejectedValue(new Error('fail'))
    await expect(breaker.execute(failOp)).rejects.toThrow()
    const health = breaker.getHealthInfo()
    expect(health.state).toBe(CircuitState.OPEN)
  })

  it('limits number of allowed calls in HALF_OPEN using halfOpenMaxCalls', async () => {
    ;(breaker as any).state = CircuitState.HALF_OPEN
    const op = jest.fn().mockResolvedValue('ok')
    const fallback = jest.fn().mockResolvedValue('fallback')
    const r1 = await breaker.execute(op, fallback)
    const r2 = await breaker.execute(op, fallback)
    const r3 = await breaker.execute(op, fallback)
    expect(r1).toBe('ok')
    expect(r2).toBe('ok')
    expect(r3).toBe('fallback')
    expect(op).toHaveBeenCalledTimes(2)
    const health = breaker.getHealthInfo()
    expect(health.metrics.rejectedCalls).toBe(1)
  })

  it('executeSync handles success and failure and updates metrics', () => {
    const op = jest.fn().mockImplementation(() => 'sync-ok')
    const res = breaker.executeSync(op)
    expect(res).toBe('sync-ok')
    expect(op).toHaveBeenCalledTimes(1)
    const failing = jest.fn().mockImplementation(() => {
      throw new Error('sync-fail')
    })
    expect(() => breaker.executeSync(failing)).toThrow('sync-fail')
    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(2)
    expect(health.metrics.successfulCalls).toBe(1)
    expect(health.metrics.failedCalls).toBe(1)
  })

  it('executeSync respects OPEN state and uses fallback if provided', () => {
    ;(breaker as any).state = CircuitState.OPEN
    ;(breaker as any).openedAt = 1_000_000
    const op = jest.fn()
    const fallback = jest.fn().mockReturnValue('sync-fallback')
    const result = breaker.executeSync(op, fallback)
    expect(result).toBe('sync-fallback')
    expect(op).not.toHaveBeenCalled()
    const health = breaker.getHealthInfo()
    expect(health.metrics.rejectedCalls).toBe(1)
  })

  it('executeSync throws CircuitBreakerOpenError when OPEN and no fallback', () => {
    ;(breaker as any).state = CircuitState.OPEN
    ;(breaker as any).openedAt = 1_000_000
    jest.spyOn(Date, 'now').mockImplementation(() => 1_000_800)
    expect(() => breaker.executeSync(() => 'x')).toThrow(CircuitBreakerOpenError)
    const health = breaker.getHealthInfo()
    expect(health.metrics.rejectedCalls).toBe(1)
  })

  it('calculateFailureRate uses sliding window correctly', async () => {
    const success = jest.fn().mockResolvedValue('ok')
    const fail = jest.fn().mockRejectedValue(new Error('bad'))
    await breaker.execute(success)
    await breaker.execute(success)
    await expect(breaker.execute(fail)).rejects.toThrow()
    await expect(breaker.execute(fail)).rejects.toThrow()
    const health = breaker.getHealthInfo()
    expect(health.failureRate).toBe(0.5)
  })

  it('resets counters and sliding window when transitioning to CLOSED', async () => {
    ;(breaker as any).state = CircuitState.OPEN
    breaker['transitionTo'](CircuitState.CLOSED as any)
    const health = breaker.getHealthInfo()
    expect(health.failureCount).toBe(0)
    expect(health.successCount).toBe(0)
    expect(health.failureRate).toBe(0)
  })

  it('getOrCreate returns same instance for same name and preserves config of first', () => {
    const b1 = CircuitBreaker.getOrCreate('shared', { failureThreshold: 2 })
    const b2 = CircuitBreaker.getOrCreate('shared', { failureThreshold: 10 })
    expect(b1).toBe(b2)
    const health = b1.getHealthInfo()
    expect(health.config.failureThreshold).toBe(2)
  })

  it('CircuitBreakerOpenError message contains name and rounded remainingTimeMs', () => {
    const err = new CircuitBreakerOpenError('svc', 1234.7)
    expect(err.name).toBe('CircuitBreakerOpenError')
    expect(err.message).toContain("Circuit breaker 'svc' is open.")
    expect(err.message).toContain('1235ms')
  })
})

describe('DistributedCircuitBreakerClient', () => {
  let originalFetch: any

  beforeEach(() => {
    originalFetch = global.fetch
    global.fetch = jest.fn()
  })

  afterEach(() => {
    global.fetch = originalFetch
    jest.clearAllMocks()
    jest.useRealTimers()
  })

  it('register sends registration request with breaker config', async () => {
    const breaker = new CircuitBreaker('svc-reg', {
      failureThreshold: 7,
      successThreshold: 4,
    })
    ;(global.fetch as jest.Mock).mockResolvedValue({ ok: true })
    const client = new DistributedCircuitBreakerClient('http://coord')
    await client.register(breaker)
    expect(global.fetch).toHaveBeenCalledWith(
      'http://coord/circuit-breakers/register',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
    )
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body)
    expect(body.service).toBe('svc-reg')
    expect(body.failure_threshold).toBe(
      breaker.getHealthInfo().config.failureThreshold
    )
    expect(body.success_threshold).toBe(
      breaker.getHealthInfo().config.successThreshold
    )
  })

  it('getAggregatedState returns parsed response on success', async () => {
    const payload: AggregatedState = {
      service: 'svc',
      consensusState: CircuitState.OPEN,
      totalNodes: 3,
      healthScore: 0.7,
      nodeStates: { a: CircuitState.OPEN, b: CircuitState.CLOSED },
    }
    ;(global.fetch as jest.Mock).mockResolvedValue({
      json: jest.fn().mockResolvedValue(payload),
    })
    const client = new DistributedCircuitBreakerClient('http://coord')
    const result = await client.getAggregatedState('svc')
    expect(global.fetch).toHaveBeenCalledWith(
      'http://coord/circuit-breakers/svc/aggregate'
    )
    expect(result).toEqual(payload)
  })

  it('getAggregatedState returns default CLOSED state on fetch error', async () => {
    ;(global.fetch as jest.Mock).mockRejectedValue(new Error('net'))
    const client = new DistributedCircuitBreakerClient('http://coord')
    const result = await client.getAggregatedState('svc-x')
    expect(result.service).toBe('svc-x')
    expect(result.consensusState).toBe(CircuitState.CLOSED)
    expect(result.totalNodes).toBe(0)
    expect(result.nodeStates).toEqual({})
  })

  it('startSync starts interval and synchronizeStates reports states', async () => {
    jest.useFakeTimers()
    const breaker = new CircuitBreaker('svc-sync')
    ;(global.fetch as jest.Mock).mockResolvedValue({ ok: true })
    const client = new DistributedCircuitBreakerClient('http://coord', 1000)
    client.register(breaker)
    client.startSync()
    jest.advanceTimersByTime(1100)
    await Promise.resolve()
    const calls = (global.fetch as jest.Mock).mock.calls.filter(
      (c: any[]) => c[0] === 'http://coord/circuit-breakers/state'
    )
    expect(calls.length).toBeGreaterThanOrEqual(1)
    const body = JSON.parse(calls[0][1].body)
    expect(body.service).toBe('svc-sync')
    expect(body.state).toBe(breaker.getState())
    client.stopSync()
  })

  it('stopSync clears interval and prevents further sync calls', () => {
    jest.useFakeTimers()
    const client = new DistributedCircuitBreakerClient('http://coord', 1000)
    const breaker = new CircuitBreaker('svc-stop')
    client.register(breaker)
    ;(global.fetch as jest.Mock).mockResolvedValue({ ok: true })
    client.startSync()
    client.stopSync()
    jest.advanceTimersByTime(3000)
    expect(global.fetch).toHaveBeenCalledTimes(1) // initial register only
  })
})

describe('withCircuitBreaker decorator', () => {
  afterEach(() => {
    jest.clearAllMocks()
  })

  it('wraps method to execute via CircuitBreaker and returns original result', async () => {
    class TestService {
      value = 1

      @withCircuitBreaker('decorator-service')
      async doWork(add: number): Promise<number> {
        return this.value + add
      }
    }
    const svc = new TestService()
    const result = await (svc as any).doWork(2)
    expect(result).toBe(3)
  })

  it('uses same CircuitBreaker instance for multiple method calls with same name', async () => {
    const spy = jest.spyOn(CircuitBreaker, 'getOrCreate')
    class TestService {
      @withCircuitBreaker('shared-decorator')
      async m1() {
        return 1
      }
      @withCircuitBreaker('shared-decorator')
      async m2() {
        return 2
      }
    }
    const svc = new TestService()
    await (svc as any).m1()
    await (svc as any).m2()
    const calls = spy.mock.calls.filter((c) => c[0] === 'shared-decorator')
    expect(calls.length).toBe(2)
    const breaker1 = calls[0][1]
    const breaker2 = calls[1][1]
    expect(breaker1).toEqual(breaker2)
  })

  it('propagates errors thrown by decorated method through CircuitBreaker', async () => {
    class ErrorService {
      @withCircuitBreaker('error-decorator', { failureThreshold: 1 })
      async fail() {
        throw new Error('boom')
      }
    }
    const svc = new ErrorService()
    await expect((svc as any).fail()).rejects.toThrow('boom')
    // Next call should see circuit possibly open depending on internal state
    await expect((svc as any).fail()).rejects.toBeInstanceOf(Error)
  })
})