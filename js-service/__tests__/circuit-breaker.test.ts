import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CircuitBreaker, CircuitBreakerOpenError, CircuitState, DistributedCircuitBreakerClient, withCircuitBreaker } from '../src/circuit-breaker'

describe('CircuitBreakerOpenError', () => {
  it('sets error name and message correctly', () => {
    const err = new CircuitBreakerOpenError('serviceX', 1234)
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('CircuitBreakerOpenError')
    expect(err.message).toContain("Circuit breaker 'serviceX' is open")
    expect(err.message).toContain('Retry after')
    expect((err as any).remainingTimeMs).toBe(1234)
  })
})

describe('CircuitBreaker basic behavior', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('records successful async execution and updates metrics', async () => {
    vi.useFakeTimers()
    const breaker = new CircuitBreaker('svc-success')
    const base = new Date('2024-01-01T00:00:00.000Z').getTime()
    vi.setSystemTime(base)

    const result = await breaker.execute(async () => {
      vi.setSystemTime(base + 50)
      return 'ok'
    })

    expect(result).toBe('ok')
    const health = breaker.getHealthInfo()
    expect(health.state).toBe(CircuitState.CLOSED)
    expect(health.metrics.totalCalls).toBe(1)
    expect(health.metrics.successfulCalls).toBe(1)
    expect(health.metrics.failedCalls).toBe(0)
    expect(health.metrics.averageResponseTimeMs).toBe(50)
    expect(health.metrics.lastSuccessTime).toBeInstanceOf(Date)
    expect(health.failureRate).toBeCloseTo(0)
  })

  it('records failures and opens after failureThreshold', async () => {
    const breaker = new CircuitBreaker('svc-open', { failureThreshold: 2 })
    await expect(breaker.execute(async () => { throw new Error('boom1') })).rejects.toThrow('boom1')
    await expect(breaker.execute(async () => { throw new Error('boom2') })).rejects.toThrow('boom2')

    expect(breaker.getState()).toBe(CircuitState.OPEN)
    const health = breaker.getHealthInfo()
    expect(health.metrics.failedCalls).toBe(2)

    await expect(breaker.execute(async () => 'should-not-run')).rejects.toBeInstanceOf(CircuitBreakerOpenError)
    expect(breaker.getHealthInfo().metrics.rejectedCalls).toBe(1)
    expect(breaker.getHealthInfo().metrics.totalCalls).toBe(2)
  })

  it('uses fallback when open', async () => {
    const breaker = new CircuitBreaker('svc-open-fallback', { failureThreshold: 1 })
    await expect(breaker.execute(async () => { throw new Error('fail') })).rejects.toThrow('fail')
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    const val = await breaker.execute(async () => 'nope', async () => 'fallback')
    expect(val).toBe('fallback')
    expect(breaker.getHealthInfo().metrics.rejectedCalls).toBe(1)
  })

  it('transitions to HALF_OPEN after timeout and closes after enough successes', async () => {
    vi.useFakeTimers()
    const breaker = new CircuitBreaker('svc-half-open-close', { failureThreshold: 1, timeoutMs: 1000, successThreshold: 2 })
    await expect(breaker.execute(async () => { throw new Error('fail') })).rejects.toThrow()
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    vi.advanceTimersByTime(1001)
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)

    const res1 = await breaker.execute(async () => 'ok1')
    expect(res1).toBe('ok1')
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)

    const res2 = await breaker.execute(async () => 'ok2')
    expect(res2).toBe('ok2')
    expect(breaker.getState()).toBe(CircuitState.CLOSED)
  })

  it('half-open failure transitions back to OPEN', async () => {
    vi.useFakeTimers()
    const breaker = new CircuitBreaker('svc-half-open-fail', { failureThreshold: 1, timeoutMs: 500 })
    await expect(breaker.execute(async () => { throw new Error('fail') })).rejects.toThrow()
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    vi.advanceTimersByTime(600)
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)
    await expect(breaker.execute(async () => { throw new Error('probe-fail') })).rejects.toThrow('probe-fail')
    expect(breaker.getState()).toBe(CircuitState.OPEN)
  })

  it('enforces halfOpenMaxCalls limit', async () => {
    vi.useFakeTimers()
    const breaker = new CircuitBreaker('svc-half-open-limit', {
      failureThreshold: 1,
      timeoutMs: 0,
      halfOpenMaxCalls: 2,
      successThreshold: 999
    })

    await expect(breaker.execute(async () => { throw new Error('fail') })).rejects.toThrow()
    expect(breaker.getState()).toBe(CircuitState.OPEN)

    // Immediately moves to HALF_OPEN due to timeout 0
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)

    await expect(breaker.execute(async () => 'ok1')).resolves.toBe('ok1')
    await expect(breaker.execute(async () => 'ok2')).resolves.toBe('ok2')
    // Third attempt should be rejected due to halfOpenMaxCalls limit
    await expect(breaker.execute(async () => 'ok3')).rejects.toBeInstanceOf(CircuitBreakerOpenError)
    const health = breaker.getHealthInfo()
    expect(health.state).toBe(CircuitState.HALF_OPEN)
    expect(health.metrics.rejectedCalls).toBe(1)
  })

  it('executeSync success updates metrics', () => {
    vi.useFakeTimers()
    const breaker = new CircuitBreaker('svc-sync-success')
    vi.setSystemTime(0)
    const result = breaker.executeSync(() => {
      vi.setSystemTime(25)
      return 42
    })
    expect(result).toBe(42)
    const health = breaker.getHealthInfo()
    expect(health.metrics.totalCalls).toBe(1)
    expect(health.metrics.successfulCalls).toBe(1)
    expect(health.metrics.averageResponseTimeMs).toBe(25)
  })

  it('executeSync failure increments and may open', () => {
    const breaker = new CircuitBreaker('svc-sync-fail', { failureThreshold: 1 })
    expect(() => breaker.executeSync(() => { throw new Error('oops') })).toThrow('oops')
    expect(breaker.getState()).toBe(CircuitState.OPEN)
  })

  it('getOrCreate returns singleton instance', () => {
    const a = CircuitBreaker.getOrCreate('registry-singleton', { failureThreshold: 1 })
    const b = CircuitBreaker.getOrCreate('registry-singleton', { failureThreshold: 999 })
    expect(a).toBe(b)
  })

  it('getRegistry returns a copy not affecting internal registry', () => {
    const breaker = CircuitBreaker.getOrCreate('registry-copy')
    const reg1 = CircuitBreaker.getRegistry()
    expect(reg1.has('registry-copy')).toBe(true)
    reg1.set('fake', breaker)
    const reg2 = CircuitBreaker.getRegistry()
    expect(reg2.has('fake')).toBe(false)
  })

  it('sliding window failure rate can open breaker before count threshold', async () => {
    const breaker = new CircuitBreaker('svc-window', {
      failureThreshold: 100,
      slidingWindowSize: 4,
      failureRateThreshold: 0.5
    })

    await expect(breaker.execute(async () => { throw new Error('f1') })).rejects.toThrow()
    expect(breaker.getState()).toBe(CircuitState.CLOSED)
    await expect(breaker.execute(async () => { throw new Error('f2') })).rejects.toThrow()
    expect(breaker.getState()).toBe(CircuitState.CLOSED)
    await expect(breaker.execute(async () => { throw new Error('f3') })).rejects.toThrow()
    expect(breaker.getState()).toBe(CircuitState.OPEN)
  })

  it('average response time keeps only the last 100 samples', async () => {
    vi.useFakeTimers()
    const breaker = new CircuitBreaker('svc-avg-100', { failureThreshold: 1000 })
    for (let i = 1; i <= 101; i++) {
      vi.setSystemTime(0)
      // Each call records duration = i ms
      await breaker.execute(async () => {
        vi.setSystemTime(i)
        return 'x'
      })
    }
    const avg = breaker.getHealthInfo().metrics.averageResponseTimeMs
    expect(avg).toBeCloseTo(51.5, 5)
  })

  it('getHealthInfo reflects dynamic state after timeout', async () => {
    vi.useFakeTimers()
    const breaker = new CircuitBreaker('svc-health', { failureThreshold: 1, timeoutMs: 100 })
    await expect(breaker.execute(async () => { throw new Error('f') })).rejects.toThrow()
    expect(breaker.getHealthInfo().state).toBe(CircuitState.OPEN)
    vi.advanceTimersByTime(150)
    expect(breaker.getHealthInfo().state).toBe(CircuitState.HALF_OPEN)
  })
})

describe('DistributedCircuitBreakerClient', () => {
  let originalFetch: any
  let fetchMock: any
  const coordinatorUrl = 'http://coordinator'

  beforeEach(() => {
    originalFetch = (globalThis as any).fetch
    fetchMock = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({})
    })
    ;(globalThis as any).fetch = fetchMock
  })

  afterEach(() => {
    ;(globalThis as any).fetch = originalFetch
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('register sends registration payload', async () => {
    const prevNodeId = process.env.NODE_ID
    process.env.NODE_ID = 'node-123'
    const client = new DistributedCircuitBreakerClient(coordinatorUrl)
    const breaker = new CircuitBreaker('svc-register', { failureThreshold: 7, successThreshold: 2 })

    client.register(breaker)

    expect(fetchMock).toHaveBeenCalled()
    const [url, options] = fetchMock.mock.calls[0]
    expect(url).toBe(`${coordinatorUrl}/circuit-breakers/register`)
    const body = JSON.parse(options.body)
    expect(body.service).toBe('svc-register')
    expect(body.node_id).toBe('node-123')
    expect(body.failure_threshold).toBe(7)
    expect(body.success_threshold).toBe(2)

    process.env.NODE_ID = prevNodeId
  })

  it('startSync posts state periodically and stopSync halts it', async () => {
    vi.useFakeTimers()
    const client = new DistributedCircuitBreakerClient(coordinatorUrl, 1000)
    const breaker = new CircuitBreaker('svc-sync')
    client.register(breaker)

    fetchMock.mockClear()
    client.startSync()

    await vi.advanceTimersByTimeAsync(3100)
    // There may be initial register call, so filter by URL
    const stateCalls = fetchMock.mock.calls.filter(([u]: any[]) => String(u).includes('/circuit-breakers/state'))
    expect(stateCalls.length).toBeGreaterThanOrEqual(3)

    const [url, options] = stateCalls[0]
    expect(url).toBe(`${coordinatorUrl}/circuit-breakers/state`)
    const body = JSON.parse(options.body)
    expect(body.service).toBe('svc-sync')
    expect(Object.values(CircuitState)).toContain(body.state)

    fetchMock.mockClear()
    client.stopSync()
    await vi.advanceTimersByTimeAsync(3000)
    const postStopCalls = fetchMock.mock.calls.filter(([u]: any[]) => String(u).includes('/circuit-breakers/state'))
    expect(postStopCalls.length).toBe(0)
  })

  it('getAggregatedState returns parsed data on success', async () => {
    const client = new DistributedCircuitBreakerClient(coordinatorUrl)
    ;(globalThis as any).fetch = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({
        service: 'svcA',
        consensusState: CircuitState.OPEN,
        totalNodes: 3,
        healthScore: 0.8,
        nodeStates: { n1: CircuitState.OPEN, n2: CircuitState.CLOSED }
      })
    })
    const data = await client.getAggregatedState('svcA')
    expect(data.service).toBe('svcA')
    expect(data.consensusState).toBe(CircuitState.OPEN)
    expect(data.totalNodes).toBe(3)
    expect(data.nodeStates.n1).toBe(CircuitState.OPEN)
  })

  it('getAggregatedState returns default on fetch error', async () => {
    const client = new DistributedCircuitBreakerClient(coordinatorUrl)
    ;(globalThis as any).fetch = vi.fn().mockRejectedValue(new Error('network'))
    const data = await client.getAggregatedState('svcB')
    expect(data.service).toBe('svcB')
    expect(data.consensusState).toBe(CircuitState.CLOSED)
    expect(data.totalNodes).toBe(0)
    expect(data.nodeStates).toEqual({})
  })
})

describe('withCircuitBreaker decorator', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('wraps method and returns original result on success', async () => {
    class Service {
      async compute(a: number, b: number) {
        return a + b
      }
    }
    const descriptor = Object.getOwnPropertyDescriptor(Service.prototype, 'compute')!
    withCircuitBreaker('decor-success')(Service.prototype as any, 'compute', descriptor)
    Object.defineProperty(Service.prototype, 'compute', descriptor)

    const svc = new Service()
    const result = await (svc as any).compute(2, 3)
    expect(result).toBe(5)
  })

  it('opens breaker after failures and rejects subsequent calls', async () => {
    class Failer {
      async doWork() {
        throw new Error('fail-once')
      }
    }
    const descriptor = Object.getOwnPropertyDescriptor(Failer.prototype, 'doWork')!
    withCircuitBreaker('decor-open', { failureThreshold: 1 })(Failer.prototype as any, 'doWork', descriptor)
    Object.defineProperty(Failer.prototype, 'doWork', descriptor)

    const svc = new Failer()
    await expect((svc as any).doWork()).rejects.toThrow('fail-once')
    await expect((svc as any).doWork()).rejects.toBeInstanceOf(CircuitBreakerOpenError)
  })
})