import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CircuitBreaker, CircuitBreakerOpenError, CircuitState, DistributedCircuitBreakerClient, withCircuitBreaker } from '../src/circuit-breaker'

describe('CircuitBreaker basic behavior', () => {
  afterEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('initial state is CLOSED and health info contains partial config', () => {
    const breaker = new CircuitBreaker('svc-initial')
    expect(breaker.getState()).toBe(CircuitState.CLOSED)
    const health = breaker.getHealthInfo()
    expect(health.name).toBe('svc-initial')
    expect(health.state).toBe(CircuitState.CLOSED)
    expect(health.failureRate).toBe(0)
    expect(health.config.failureThreshold).toBeDefined()
    expect(health.config.successThreshold).toBeDefined()
    expect(health.config.timeoutMs).toBeDefined()
  })

  it('records successful async execution and averages response time', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2020-01-01T00:00:00Z'))
    const breaker = new CircuitBreaker('svc-success', { timeoutMs: 1000 })

    const op = () => new Promise<string>((resolve) => setTimeout(() => resolve('ok'), 100))
    const execPromise = breaker.execute(op)
    await vi.advanceTimersByTimeAsync(100)
    const result = await execPromise

    expect(result).toBe('ok')

    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(1)
    expect(health.metrics.successfulCalls).toBe(1)
    expect(health.metrics.failedCalls).toBe(0)
    expect(health.metrics.averageResponseTimeMs).toBe(100)
    expect(health.metrics.lastSuccessTime).toBeInstanceOf(Date)
  })

  it('records failures and opens after reaching failureThreshold', async () => {
    const breaker = new CircuitBreaker('svc-fails', {
      failureThreshold: 2,
      slidingWindowSize: 2,
      failureRateThreshold: 1, // ensure failure rate alone doesn't open early
      timeoutMs: 1000,
    })

    const failOp = async () => {
      throw new Error('boom1')
    }
    await expect(breaker.execute(failOp)).rejects.toBeInstanceOf(Error)
    await expect(breaker.execute(failOp)).rejects.toBeInstanceOf(Error)

    expect(breaker.getState()).toBe(CircuitState.OPEN)
    const health = breaker.getHealthInfo()
    expect(health.metrics.failedCalls).toBe(2)
    expect(health.metrics.totalCalls).toBe(2)
    expect(health.metrics.lastFailureTime).toBeInstanceOf(Date)
  })

  it('rejects new calls when OPEN with CircuitBreakerOpenError and remainingTimeMs <= timeout', async () => {
    const breaker = new CircuitBreaker('svc-open-reject', {
      failureThreshold: 1,
      slidingWindowSize: 2,
      failureRateThreshold: 1,
      timeoutMs: 500,
    })
    const failOp = async () => {
      throw new Error('fail')
    }
    await expect(breaker.execute(failOp)).rejects.toBeInstanceOf(Error)
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    const okOp = async () => 'ok'
    try {
      await breaker.execute(okOp)
      throw new Error('should have thrown')
    } catch (err: any) {
      expect(err).toBeInstanceOf(CircuitBreakerOpenError)
      expect(err.name).toBe('CircuitBreakerOpenError')
      expect(typeof err.remainingTimeMs).toBe('number')
      expect(err.remainingTimeMs).toBeGreaterThan(0)
      expect(err.remainingTimeMs).toBeLessThanOrEqual(500)
    }

    const health = breaker.getHealthInfo()
    expect(health.metrics.rejectedCalls).toBe(1)
  })

  it('uses fallback when OPEN and increments rejectedCalls without increasing totalCalls (async)', async () => {
    const breaker = new CircuitBreaker('svc-fallback-async', {
      failureThreshold: 1,
      timeoutMs: 1000,
      slidingWindowSize: 2,
      failureRateThreshold: 1,
    })

    const failing = async () => {
      throw new Error('nope')
    }
    await expect(breaker.execute(failing)).rejects.toBeInstanceOf(Error)
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    const prev = breaker.getHealthInfo().metrics
    const result = await breaker.execute(async () => 'real', async () => 'fallback')
    expect(result).toBe('fallback')
    const after = breaker.getHealthInfo().metrics
    expect(after.rejectedCalls).toBe(prev.rejectedCalls + 1)
    expect(after.totalCalls).toBe(prev.totalCalls) // no additional allowed call counted
  })

  it('uses fallback when HALF_OPEN has exceeded max calls (sync)', () => {
    vi.useFakeTimers()
    const breaker = new CircuitBreaker('svc-fallback-sync', {
      failureThreshold: 1,
      timeoutMs: 1000,
      halfOpenMaxCalls: 1,
      successThreshold: 5, // keep in HALF_OPEN
      slidingWindowSize: 2,
      failureRateThreshold: 1,
    })
    // Open it
    expect(() => breaker.executeSync(() => { throw new Error('fail') })).toThrowError()
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    // Advance to allow HALF_OPEN
    vi.advanceTimersByTime(1000)
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)

    // First allowed call (success)
    const res1 = breaker.executeSync(() => 'first')
    expect(res1).toBe('first')

    // Second call should be rejected due to halfOpenMaxCalls=1, so fallback used
    const before = breaker.getHealthInfo().metrics
    const res2 = breaker.executeSync(() => 'second', () => 'fallback-sync')
    expect(res2).toBe('fallback-sync')
    const after = breaker.getHealthInfo().metrics
    expect(after.rejectedCalls).toBe(before.rejectedCalls + 1)
    expect(after.totalCalls).toBe(before.totalCalls) // not allowed call
  })

  it('transitions from OPEN -> HALF_OPEN after timeout and then CLOSED after enough successes', async () => {
    vi.useFakeTimers()
    const breaker = new CircuitBreaker('svc-reset-success', {
      failureThreshold: 1,
      timeoutMs: 500,
      successThreshold: 2,
      halfOpenMaxCalls: 3,
      slidingWindowSize: 2,
      failureRateThreshold: 1,
    })

    await expect(breaker.execute(async () => { throw new Error('x') })).rejects.toBeInstanceOf(Error)
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    vi.advanceTimersByTime(500)
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)

    await breaker.execute(async () => 'ok1')
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)
    await breaker.execute(async () => 'ok2')
    expect(breaker.getState()).toBe(CircuitState.CLOSED)
  })

  it('transitions from HALF_OPEN to OPEN on a single failure', async () => {
    vi.useFakeTimers()
    const breaker = new CircuitBreaker('svc-reset-fail', {
      failureThreshold: 1,
      timeoutMs: 300,
      successThreshold: 2,
      halfOpenMaxCalls: 3,
      slidingWindowSize: 2,
      failureRateThreshold: 1,
    })

    await expect(breaker.execute(async () => { throw new Error('x') })).rejects.toBeInstanceOf(Error)
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    vi.advanceTimersByTime(300)
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)

    await expect(breaker.execute(async () => { throw new Error('probe fail') })).rejects.toBeInstanceOf(Error)
    expect(breaker.getState()).toBe(CircuitState.OPEN)
  })

  it('HALF_OPEN respects halfOpenMaxCalls and rejects extra attempts', async () => {
    vi.useFakeTimers()
    const breaker = new CircuitBreaker('svc-half-open-max', {
      failureThreshold: 1,
      timeoutMs: 200,
      successThreshold: 5,
      halfOpenMaxCalls: 2,
      slidingWindowSize: 2,
      failureRateThreshold: 1,
    })

    await expect(breaker.execute(async () => { throw new Error('x') })).rejects.toBeInstanceOf(Error)
    vi.advanceTimersByTime(200)
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)

    await breaker.execute(async () => 'ok')
    await breaker.execute(async () => 'ok')
    const metricsBefore = breaker.getHealthInfo().metrics

    try {
      await breaker.execute(async () => 'should reject')
      throw new Error('expected reject')
    } catch (err: any) {
      expect(err).toBeInstanceOf(CircuitBreakerOpenError)
    }
    const metricsAfter = breaker.getHealthInfo().metrics
    expect(metricsAfter.rejectedCalls).toBe(metricsBefore.rejectedCalls + 1)
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)
  })

  it('opens due to sliding window failure rate threshold even if failureCount below threshold', async () => {
    const breaker = new CircuitBreaker('svc-rate-open', {
      failureThreshold: 99,
      slidingWindowSize: 2,
      failureRateThreshold: 0.5,
      timeoutMs: 1000,
    })

    await expect(breaker.execute(async () => { throw new Error('fail once') })).rejects.toBeInstanceOf(Error)
    expect(breaker.getState()).toBe(CircuitState.OPEN)
  })

  it('executeSync handles success and failure, updating metrics', () => {
    const breaker = new CircuitBreaker('svc-sync', {
      failureThreshold: 2,
      slidingWindowSize: 2,
      failureRateThreshold: 1,
    })

    const res = breaker.executeSync(() => 42)
    expect(res).toBe(42)
    let health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(1)
    expect(health.metrics.successfulCalls).toBe(1)
    expect(health.metrics.failedCalls).toBe(0)

    expect(() => breaker.executeSync(() => { throw new Error('bad') })).toThrowError()
    health = breaker.getHealthInfo()
    expect(health.metrics.failedCalls).toBe(1)
    expect(health.metrics.totalCalls).toBe(2)
  })

  it('getRegistry returns a copy that does not mutate the internal registry', () => {
    const breaker = CircuitBreaker.getOrCreate('reg-test')
    const reg1 = CircuitBreaker.getRegistry()
    expect(reg1.has('reg-test')).toBe(true)

    reg1.clear()
    const reg2 = CircuitBreaker.getRegistry()
    expect(reg2.has('reg-test')).toBe(true)
    // Ensure same instance returned for same name
    const again = CircuitBreaker.getOrCreate('reg-test')
    expect(again).toBe(breaker)
  })

  it('health info timestamps update on success and failure', async () => {
    const breaker = new CircuitBreaker('svc-health-ts', {
      failureThreshold: 2,
      slidingWindowSize: 2,
      failureRateThreshold: 1,
    })
    await breaker.execute(async () => 'ok')
    let health = breaker.getHealthInfo()
    expect(health.metrics.lastSuccessTime).toBeInstanceOf(Date)

    await expect(breaker.execute(async () => { throw new Error('err') })).rejects.toBeInstanceOf(Error)
    health = breaker.getHealthInfo()
    expect(health.metrics.lastFailureTime).toBeInstanceOf(Date)
  })
})

describe('DistributedCircuitBreakerClient', () => {
  const originalEnv = { ...process.env }
  beforeEach(() => {
    vi.clearAllMocks()
  })
  afterEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
    process.env = { ...originalEnv }
  })

  it('getAggregatedState returns default on fetch failure', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network'))
    // @ts-expect-error set global fetch
    global.fetch = fetchMock

    const client = new DistributedCircuitBreakerClient('http://coordinator')
    const state = await client.getAggregatedState('svc')
    expect(state.service).toBe('svc')
    expect(state.consensusState).toBe(CircuitState.CLOSED)
    expect(state.totalNodes).toBe(0)
    expect(state.healthScore).toBe(0)
    expect(state.nodeStates).toEqual({})
  })

  it('register posts to coordinator with breaker config', async () => {
    process.env.NODE_ID = 'node-1'
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    // @ts-expect-error set global fetch
    global.fetch = fetchMock

    const client = new DistributedCircuitBreakerClient('http://coordinator')
    const breaker = new CircuitBreaker('payments')
    client.register(breaker)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, options] = fetchMock.mock.calls[0]
    expect(url).toBe('http://coordinator/circuit-breakers/register')
    expect(options.method).toBe('POST')
    const body = JSON.parse(options.body as string)
    expect(body.service).toBe('payments')
    expect(body.node_id).toBe('node-1')
    expect(body.failure_threshold).toBe(breaker.getHealthInfo().config.failureThreshold)
    expect(body.success_threshold).toBe(breaker.getHealthInfo().config.successThreshold)
  })

  it('startSync schedules state reports and stopSync cancels them', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    // @ts-expect-error set global fetch
    global.fetch = fetchMock

    const client = new DistributedCircuitBreakerClient('http://coord', 1000)
    const breaker = new CircuitBreaker('orders')
    client.register(breaker)
    fetchMock.mockClear()

    client.startSync()
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const call = fetchMock.mock.calls[0]
    expect(call[0]).toBe('http://coord/circuit-breakers/state')
    const stateBody = JSON.parse((call[1] as any).body)
    expect(stateBody.service).toBe('orders')
    expect(stateBody.state).toBe(breaker.getState())
    expect(typeof stateBody.timestamp).toBe('number')
    expect(stateBody.health_info.name).toBe('orders')

    client.stopSync()
    fetchMock.mockClear()
    await vi.advanceTimersByTimeAsync(2000)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('getAggregatedState returns coordinator-provided JSON', async () => {
    const aggregated = {
      service: 'svc',
      consensusState: CircuitState.HALF_OPEN,
      totalNodes: 3,
      healthScore: 0.75,
      nodeStates: { a: CircuitState.OPEN, b: CircuitState.CLOSED },
    }
    const fetchMock = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue(aggregated),
    })
    // @ts-expect-error set global fetch
    global.fetch = fetchMock

    const client = new DistributedCircuitBreakerClient('http://coordinator')
    const state = await client.getAggregatedState('svc')
    expect(state).toEqual(aggregated)
  })
})

describe('withCircuitBreaker decorator', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('wraps method to execute through CircuitBreaker and records metrics', async () => {
    const name = 'decorator-test-1'
    class Service {
      value = 10
      async compute(mult: number) {
        return this.value * mult
      }
    }
    const descriptor = Object.getOwnPropertyDescriptor(Service.prototype, 'compute')!
    const decorator = withCircuitBreaker(name, { timeoutMs: 1000 })
    const newDescriptor = decorator(Service.prototype as any, 'compute', descriptor)!
    Object.defineProperty(Service.prototype, 'compute', newDescriptor)

    const svc = new Service()
    const result = await (svc as any).compute(3)
    expect(result).toBe(30)

    const breaker = CircuitBreaker.getOrCreate(name)
    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(1)
    expect(health.metrics.successfulCalls).toBe(1)
    expect(breaker.getState()).toBe(CircuitState.CLOSED)
  })

  it('records failure through decorator and can open breaker', async () => {
    const name = 'decorator-test-2'
    class Service {
      async fail() {
        throw new Error('nope')
      }
    }
    const descriptor = Object.getOwnPropertyDescriptor(Service.prototype, 'fail')!
    const decorator = withCircuitBreaker(name, {
      failureThreshold: 1,
      slidingWindowSize: 2,
      failureRateThreshold: 1,
    })
    const newDescriptor = decorator(Service.prototype as any, 'fail', descriptor)!
    Object.defineProperty(Service.prototype, 'fail', newDescriptor)

    const svc = new Service()
    await expect((svc as any).fail()).rejects.toBeInstanceOf(Error)
    const breaker = CircuitBreaker.getOrCreate(name)
    expect(breaker.getState()).toBe(CircuitState.OPEN)
    const health = breaker.getHealthInfo()
    expect(health.metrics.failedCalls).toBe(1)
  })
})