import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals'
import { CircuitBreaker, CircuitBreakerOpenError, CircuitState, DistributedCircuitBreakerClient, withCircuitBreaker } from '../src/circuit-breaker'

describe('CircuitBreaker - basic behavior', () => {
  afterEach(() => {
    jest.clearAllMocks()
    jest.restoreAllMocks()
  })

  it('executes successful async operation and updates metrics and state', async () => {
    const breaker = new CircuitBreaker('svc-success', { timeoutMs: 1000 })
    let now = 1000
    jest.spyOn(Date, 'now').mockImplementation(() => now)

    const result = await breaker.execute(async () => {
      now += 50
      return 'ok'
    })

    expect(result).toBe('ok')
    const health = breaker.getHealthInfo()
    expect(health.state).toBe(CircuitState.CLOSED)
    expect(health.metrics.successfulCalls).toBe(1)
    expect(health.metrics.totalCalls).toBe(1)
    expect(health.metrics.failedCalls).toBe(0)
    expect(health.metrics.lastSuccessTime).toBeInstanceOf(Date)
    expect(health.metrics.averageResponseTimeMs).toBe(50)
  })

  it('records failed async operation and increments failureCount without opening before threshold', async () => {
    const breaker = new CircuitBreaker('svc-fail', { failureThreshold: 5 })
    await expect(
      breaker.execute(async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')

    const health = breaker.getHealthInfo()
    expect(health.failureCount).toBe(1)
    expect(health.state).toBe(CircuitState.CLOSED)
    expect(health.metrics.failedCalls).toBe(1)
    expect(health.metrics.lastFailureTime).toBeInstanceOf(Date)
  })

  it('opens after reaching failureThreshold and rejects further calls with CircuitBreakerOpenError', async () => {
    const breaker = new CircuitBreaker('svc-open', { failureThreshold: 2, timeoutMs: 1000 })
    let now = 0
    jest.spyOn(Date, 'now').mockImplementation(() => now)

    // Two failures to open
    await expect(breaker.execute(async () => { throw new Error('f1') })).rejects.toThrow('f1')
    await expect(breaker.execute(async () => { throw new Error('f2') })).rejects.toThrow('f2')

    expect(breaker.getState()).toBe(CircuitState.OPEN)

    // Now reject immediately with CircuitBreakerOpenError
    const attempt = breaker.execute(async () => 'ok')
    await expect(attempt).rejects.toBeInstanceOf(CircuitBreakerOpenError)
    await attempt.catch((err: any) => {
      expect(err.name).toBe('CircuitBreakerOpenError')
      expect(err.message).toContain("Circuit breaker 'svc-open' is open")
      expect(err.remainingTimeMs).toBeGreaterThanOrEqual(0)
    })

    const health = breaker.getHealthInfo()
    expect(health.metrics.rejectedCalls).toBe(1)
    expect(health.metrics.totalCalls).toBe(2) // only actual attempts counted
  })

  it('uses fallback when open', async () => {
    const breaker = new CircuitBreaker('svc-open-fb', { failureThreshold: 1, timeoutMs: 1000 })
    await expect(breaker.execute(async () => { throw new Error('fail') })).rejects.toThrow('fail')
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    const res = await breaker.execute(async () => 'ok', async () => 'fallback')
    expect(res).toBe('fallback')
    const health = breaker.getHealthInfo()
    expect(health.metrics.rejectedCalls).toBe(1)
    expect(health.metrics.totalCalls).toBe(1)
  })

  it('transitions to HALF_OPEN after timeout and limits half-open calls', async () => {
    const breaker = new CircuitBreaker('svc-half', { failureThreshold: 1, timeoutMs: 100, halfOpenMaxCalls: 2, successThreshold: 3 })
    let now = 0
    jest.spyOn(Date, 'now').mockImplementation(() => now)

    // Open it
    await expect(breaker.execute(async () => { throw new Error('x') })).rejects.toThrow('x')
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    // Advance time to allow HALF_OPEN
    now += 150
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)

    // Two calls are allowed
    const r1 = await breaker.execute(async () => {
      now += 10
      return 'ok1'
    })
    const r2 = await breaker.execute(async () => {
      now += 20
      return 'ok2'
    })
    expect(r1).toBe('ok1')
    expect(r2).toBe('ok2')

    // Third call should be rejected due to halfOpenMaxCalls limit
    await expect(breaker.execute(async () => 'ok3')).rejects.toBeInstanceOf(CircuitBreakerOpenError)
    const health = breaker.getHealthInfo()
    expect(health.state).toBe(CircuitState.HALF_OPEN)
    expect(health.metrics.rejectedCalls).toBe(1)
  })

  it('in HALF_OPEN: a failure transitions back to OPEN', async () => {
    const breaker = new CircuitBreaker('svc-half-fail', { failureThreshold: 1, timeoutMs: 50, halfOpenMaxCalls: 2 })
    let now = 0
    jest.spyOn(Date, 'now').mockImplementation(() => now)
    // Open
    await expect(breaker.execute(async () => { throw new Error('e') })).rejects.toThrow('e')
    expect(breaker.getState()).toBe(CircuitState.OPEN)
    // Wait to half open
    now += 60
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)
    // Cause a failure
    await expect(breaker.execute(async () => { throw new Error('half-open-failure') })).rejects.toThrow('half-open-failure')
    expect(breaker.getState()).toBe(CircuitState.OPEN)
  })

  it('in HALF_OPEN: successThreshold successes transition to CLOSED', async () => {
    const breaker = new CircuitBreaker('svc-half-success', { failureThreshold: 1, timeoutMs: 10, halfOpenMaxCalls: 10, successThreshold: 2 })
    let now = 0
    jest.spyOn(Date, 'now').mockImplementation(() => now)
    // Open
    await expect(breaker.execute(async () => { throw new Error('e') })).rejects.toThrow('e')
    expect(breaker.getState()).toBe(CircuitState.OPEN)
    now += 11
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)

    await breaker.execute(async () => {
      now += 5
      return 'ok'
    })
    await breaker.execute(async () => {
      now += 5
      return 'ok-2'
    })

    expect(breaker.getState()).toBe(CircuitState.CLOSED)
  })

  it('opens due to sliding window failure rate threshold', async () => {
    const breaker = new CircuitBreaker('svc-window', {
      failureThreshold: 100, // high so it doesn't trigger
      slidingWindowSize: 4,
      failureRateThreshold: 0.5,
    })

    // Three failures among first four positions -> 0.75 failure rate
    await expect(breaker.execute(async () => { throw new Error('f1') })).rejects.toThrow('f1')
    await expect(breaker.execute(async () => { throw new Error('f2') })).rejects.toThrow('f2')
    await expect(breaker.execute(async () => { throw new Error('f3') })).rejects.toThrow('f3')

    expect(breaker.getState()).toBe(CircuitState.OPEN)
  })

  it('executeSync: success and failure update metrics and propagate error', () => {
    const breaker = new CircuitBreaker('svc-sync')
    let now = 1000
    jest.spyOn(Date, 'now').mockImplementation(() => now)

    const res = breaker.executeSync(() => {
      now += 7
      return 42
    })
    expect(res).toBe(42)
    expect(breaker.getHealthInfo().metrics.successfulCalls).toBe(1)

    expect(() => breaker.executeSync(() => {
      now += 3
      throw new Error('sync-fail')
    })).toThrow('sync-fail')

    const health = breaker.getHealthInfo()
    expect(health.metrics.failedCalls).toBe(1)
  })

  it('executeSync: uses fallback when open', () => {
    const breaker = new CircuitBreaker('svc-sync-open', { failureThreshold: 1, timeoutMs: 1000 })
    expect(() => breaker.executeSync(() => { throw new Error('boom') })).toThrow('boom')
    expect(breaker.getState()).toBe(CircuitState.OPEN)
    const value = breaker.executeSync(() => 1, () => 99)
    expect(value).toBe(99)
    const health = breaker.getHealthInfo()
    expect(health.metrics.rejectedCalls).toBe(1)
    expect(health.metrics.totalCalls).toBe(1)
  })

  it('getOrCreate returns same instance for same name, getRegistry returns a copy', () => {
    const a1 = CircuitBreaker.getOrCreate('shared')
    const a2 = CircuitBreaker.getOrCreate('shared')
    expect(a1).toBe(a2)

    const regCopy = CircuitBreaker.getRegistry()
    regCopy.set('new', new CircuitBreaker('new'))
    const regCopyAgain = CircuitBreaker.getRegistry()
    expect(regCopyAgain.has('new')).toBe(false)
  })

  it('getHealthInfo returns expected structure and partial config', async () => {
    const breaker = new CircuitBreaker('svc-health', { failureThreshold: 9, successThreshold: 4, timeoutMs: 1234, slidingWindowSize: 20 })
    await breaker.execute(async () => 'ok')
    const info = breaker.getHealthInfo()
    expect(info.name).toBe('svc-health')
    expect(Object.values(CircuitState)).toContain(info.state)
    expect(info.metrics.totalCalls).toBe(1)
    expect(info.config.failureThreshold).toBe(9)
    expect(info.config.successThreshold).toBe(4)
    expect(info.config.timeoutMs).toBe(1234)
    expect((info.config as any).slidingWindowSize).toBeUndefined()
  })

  it('averageResponseTimeMs keeps only last 100 durations', async () => {
    const breaker = new CircuitBreaker('svc-avg')
    let now = 0
    jest.spyOn(Date, 'now').mockImplementation(() => now)
    for (let i = 1; i <= 120; i++) {
      await breaker.execute(async () => {
        now += i
        return i
      })
    }
    // Average of 21..120 is (21+120)/2 = 70.5
    const avg = breaker.getHealthInfo().metrics.averageResponseTimeMs
    expect(avg).toBeCloseTo(70.5, 5)
  })
})

describe('DistributedCircuitBreakerClient', () => {
  const originalFetch = global.fetch
  const originalEnv = process.env
  beforeEach(() => {
    jest.useFakeTimers()
    ;(global as any).fetch = jest.fn(async () => ({
      json: async () => ({ ok: true }),
    }))
    process.env = { ...originalEnv, NODE_ID: 'node-1' }
  })
  afterEach(() => {
    jest.useRealTimers()
    jest.clearAllMocks()
    ;(global as any).fetch = originalFetch as any
    process.env = originalEnv
  })

  it('register sends POST to /register with correct body', async () => {
    const client = new DistributedCircuitBreakerClient('http://coordinator', 1000)
    const breaker = new CircuitBreaker('service-A', { failureThreshold: 7, successThreshold: 2 })
    client.register(breaker)

    await Promise.resolve()

    const calls = (fetch as jest.Mock).mock.calls.filter(c => String(c[0]).includes('/circuit-breakers/register'))
    expect(calls.length).toBe(1)
    const [url, options] = calls[0]
    expect(url).toBe('http://coordinator/circuit-breakers/register')
    expect(options.method).toBe('POST')
    const body = JSON.parse(options.body)
    expect(body.service).toBe('service-A')
    expect(body.node_id).toBe('node-1')
    expect(body.failure_threshold).toBe(7)
    expect(body.success_threshold).toBe(2)
  })

  it('startSync reports state periodically for registered breakers', async () => {
    const client = new DistributedCircuitBreakerClient('http://coord', 500)
    const b1 = new CircuitBreaker('svc1')
    const b2 = new CircuitBreaker('svc2')
    client.register(b1)
    client.register(b2)

    // reset calls after registration
    ;(fetch as jest.Mock).mockClear()

    client.startSync()
    jest.advanceTimersByTime(500)
    await Promise.resolve()

    const stateCalls = (fetch as jest.Mock).mock.calls.filter(c => String(c[0]).includes('/circuit-breakers/state'))
    expect(stateCalls.length).toBe(2)
    for (const call of stateCalls) {
      const [url, options] = call
      expect(url).toBe('http://coord/circuit-breakers/state')
      expect(options.method).toBe('POST')
      const payload = JSON.parse(options.body)
      expect(['svc1', 'svc2']).toContain(payload.service)
      expect(payload.node_id).toBe('node-1')
      expect(Object.values(CircuitState)).toContain(payload.state)
      expect(typeof payload.timestamp).toBe('number')
      expect(payload.health_info).toBeDefined()
      expect(payload.health_info.name).toBe(payload.service)
    }
    client.stopSync()
  })

  it('stopSync clears the interval and prevents further state reports', async () => {
    const client = new DistributedCircuitBreakerClient('http://coord', 300)
    const b = new CircuitBreaker('svc-stop')
    client.register(b)
    ;(fetch as jest.Mock).mockClear()

    client.startSync()
    jest.advanceTimersByTime(300)
    await Promise.resolve()
    const firstRound = (fetch as jest.Mock).mock.calls.filter(c => String(c[0]).includes('/circuit-breakers/state')).length
    expect(firstRound).toBe(1)

    client.stopSync()
    ;(fetch as jest.Mock).mockClear()
    jest.advanceTimersByTime(600)
    await Promise.resolve()
    const afterStop = (fetch as jest.Mock).mock.calls.filter(c => String(c[0]).includes('/circuit-breakers/state')).length
    expect(afterStop).toBe(0)
  })

  it('getAggregatedState returns payload from coordinator', async () => {
    const payload = {
      service: 'svc-agg',
      consensusState: CircuitState.OPEN,
      totalNodes: 3,
      healthScore: 0.75,
      nodeStates: { n1: CircuitState.OPEN, n2: CircuitState.CLOSED },
    }
    ;(fetch as jest.Mock).mockResolvedValueOnce({
      json: async () => payload,
    })

    const client = new DistributedCircuitBreakerClient('http://coord', 1000)
    const res = await client.getAggregatedState('svc-agg')
    expect(res).toEqual(payload)
  })

  it('getAggregatedState returns default on error', async () => {
    ;(fetch as jest.Mock).mockRejectedValueOnce(new Error('network'))

    const client = new DistributedCircuitBreakerClient('http://coord', 1000)
    const res = await client.getAggregatedState('svc-x')
    expect(res.service).toBe('svc-x')
    expect(res.consensusState).toBe(CircuitState.CLOSED)
    expect(res.totalNodes).toBe(0)
    expect(res.healthScore).toBe(0)
    expect(res.nodeStates).toEqual({})
  })

  it('register uses default node id when NODE_ID is not set', async () => {
    process.env = { ...process.env }
    delete process.env.NODE_ID
    const client = new DistributedCircuitBreakerClient('http://coord', 1000)
    const breaker = new CircuitBreaker('svc-default-node')
    client.register(breaker)
    await Promise.resolve()
    const calls = (fetch as jest.Mock).mock.calls.filter(c => String(c[0]).includes('/circuit-breakers/register'))
    const body = JSON.parse(calls[0][1].body)
    expect(body.node_id).toBe(`ts-${process.pid}`)
  })
})

describe('withCircuitBreaker decorator', () => {
  afterEach(() => {
    jest.clearAllMocks()
  })

  it('wraps a method and executes through CircuitBreaker', async () => {
    const name = `decorator-${Date.now()}-success`
    class Service {
      async op(x: number) {
        return x * 2
      }
    }
    const decorator = withCircuitBreaker(name, { failureThreshold: 2 })
    const desc = Object.getOwnPropertyDescriptor(Service.prototype, 'op')!
    const newDesc = decorator(Service.prototype, 'op', desc)
    Object.defineProperty(Service.prototype, 'op', newDesc)

    const svc = new Service()
    const res = await (svc as any).op(5)
    expect(res).toBe(10)

    const breaker = CircuitBreaker.getOrCreate(name)
    const health = breaker.getHealthInfo()
    expect(health.metrics.successfulCalls).toBeGreaterThanOrEqual(1)
  })

  it('on failure, updates breaker metrics and may open based on threshold', async () => {
    const name = `decorator-${Date.now()}-fail`
    class Service {
      async op() {
        throw new Error('decorated boom')
      }
    }
    const decorator = withCircuitBreaker(name, { failureThreshold: 1, timeoutMs: 1000 })
    const desc = Object.getOwnPropertyDescriptor(Service.prototype, 'op')!
    const newDesc = decorator(Service.prototype, 'op', desc)
    Object.defineProperty(Service.prototype, 'op', newDesc)

    const svc = new Service()
    await expect((svc as any).op()).rejects.toThrow('decorated boom')

    const breaker = CircuitBreaker.getOrCreate(name)
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    // Subsequent call should be rejected by breaker
    await expect((svc as any).op()).rejects.toBeInstanceOf(CircuitBreakerOpenError)
  })

  it('multiple instances share the same breaker by name', async () => {
    const name = `decorator-shared-${Date.now()}`
    class Service {
      async op() { return 'ok' }
    }
    const decorator = withCircuitBreaker(name)
    const desc = Object.getOwnPropertyDescriptor(Service.prototype, 'op')!
    const newDesc = decorator(Service.prototype, 'op', desc)
    Object.defineProperty(Service.prototype, 'op', newDesc)

    const s1 = new Service()
    const s2 = new Service()
    await (s1 as any).op()
    const breaker = CircuitBreaker.getOrCreate(name)
    const before = breaker.getHealthInfo().metrics.successfulCalls
    await (s2 as any).op()
    const after = breaker.getHealthInfo().metrics.successfulCalls
    expect(after).toBe(before + 1)
  })
})