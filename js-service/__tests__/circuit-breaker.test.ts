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

  it('starts in CLOSED state with healthy sliding window resulting in failureRate 0', () => {
    const cb = new CircuitBreaker('svc-a')
    const info = cb.getHealthInfo()
    expect(info.name).toBe('svc-a')
    expect(info.state).toBe(CircuitState.CLOSED)
    expect(info.failureRate).toBe(0)
    expect(info.failureCount).toBe(0)
    expect(info.successCount).toBe(0)
    expect(info.metrics.totalCalls).toBe(0)
    expect(info.metrics.averageResponseTimeMs).toBe(0)
  })

  it('execute records success metrics and response time average', async () => {
    const cb = new CircuitBreaker('svc-b')
    const op = vi.fn(async () => {
      vi.advanceTimersByTime(25)
      return 'ok'
    })

    const p = cb.execute(op)
    await vi.runAllTimersAsync()
    const result = await p

    expect(result).toBe('ok')
    const info = cb.getHealthInfo()
    expect(op).toHaveBeenCalledTimes(1)
    expect(info.metrics.totalCalls).toBe(1)
    expect(info.metrics.successfulCalls).toBe(1)
    expect(info.metrics.failedCalls).toBe(0)
    expect(info.metrics.lastSuccessTime).toBeInstanceOf(Date)
    expect(info.metrics.averageResponseTimeMs).toBe(25)
  })

  it('execute records failure metrics, rethrows original error, and updates average response time', async () => {
    const cb = new CircuitBreaker('svc-c')
    const err = new Error('boom')
    const op = vi.fn(async () => {
      vi.advanceTimersByTime(10)
      throw err
    })

    const p = cb.execute(op)
    await vi.runAllTimersAsync()

    await expect(p).rejects.toBe(err)

    const info = cb.getHealthInfo()
    expect(info.metrics.totalCalls).toBe(1)
    expect(info.metrics.successfulCalls).toBe(0)
    expect(info.metrics.failedCalls).toBe(1)
    expect(info.metrics.lastFailureTime).toBeInstanceOf(Date)
    expect(info.metrics.averageResponseTimeMs).toBe(10)
  })

  it('executeSync records success and returns value', () => {
    const cb = new CircuitBreaker('svc-d')
    const op = vi.fn(() => {
      vi.advanceTimersByTime(7)
      return 123
    })

    const result = cb.executeSync(op)

    expect(result).toBe(123)
    const info = cb.getHealthInfo()
    expect(info.metrics.totalCalls).toBe(1)
    expect(info.metrics.successfulCalls).toBe(1)
    expect(info.metrics.failedCalls).toBe(0)
    expect(info.metrics.averageResponseTimeMs).toBe(7)
  })

  it('executeSync records failure and rethrows', () => {
    const cb = new CircuitBreaker('svc-e')
    const err = new Error('sync boom')
    const op = vi.fn(() => {
      vi.advanceTimersByTime(4)
      throw err
    })

    expect(() => cb.executeSync(op)).toThrow(err)

    const info = cb.getHealthInfo()
    expect(info.metrics.totalCalls).toBe(1)
    expect(info.metrics.successfulCalls).toBe(0)
    expect(info.metrics.failedCalls).toBe(1)
    expect(info.metrics.lastFailureTime).toBeInstanceOf(Date)
    expect(info.metrics.averageResponseTimeMs).toBe(4)
  })

  it('trips to OPEN after consecutive failures and rejects while OPEN', async () => {
    const cb = new CircuitBreaker('svc-f')

    const fail = vi.fn(async () => {
      vi.advanceTimersByTime(1)
      throw new Error('fail')
    })

    // Drive it into OPEN with a few failures (threshold is implementation-specific; 3 is a common default)
    for (let i = 0; i < 3; i++) {
      const p = cb.execute(fail)
      await vi.runAllTimersAsync()
      await expect(p).rejects.toBeInstanceOf(Error)
    }

    // Once OPEN, subsequent calls should reject with CircuitBreakerOpenError
    await expect(cb.execute(async () => 'ok')).rejects.toBeInstanceOf(CircuitBreakerOpenError)
    expect([CircuitState.OPEN, CircuitState.HALF_OPEN]).toContain(cb.getHealthInfo().state)
  })

  it('transitions to HALF_OPEN after cooldown and allows a trial call', async () => {
    const cb = new CircuitBreaker('svc-g')

    const fail = vi.fn(async () => {
      vi.advanceTimersByTime(1)
      throw new Error('fail')
    })

    // Trip it open
    for (let i = 0; i < 3; i++) {
      const p = cb.execute(fail)
      await vi.runAllTimersAsync()
      await expect(p).rejects.toBeInstanceOf(Error)
    }

    // Advance time enough for any reasonable cooldown to pass, then call again
    vi.advanceTimersByTime(60_000)
    await vi.runAllTimersAsync()

    const op = vi.fn(async () => {
      vi.advanceTimersByTime(2)
      return 'ok'
    })

    const p2 = cb.execute(op)
    await vi.runAllTimersAsync()
    const result = await p2

    expect(result).toBe('ok')
    expect(op).toHaveBeenCalledTimes(1)
    expect(cb.getHealthInfo().metrics.totalCalls).toBeGreaterThan(0)
  })

  it('closes again after a successful HALF_OPEN trial', async () => {
    const cb = new CircuitBreaker('svc-h')

    const fail = vi.fn(async () => {
      vi.advanceTimersByTime(1)
      throw new Error('fail')
    })

    for (let i = 0; i < 3; i++) {
      const p = cb.execute(fail)
      await vi.runAllTimersAsync()
      await expect(p).rejects.toBeInstanceOf(Error)
    }

    vi.advanceTimersByTime(60_000)
    await vi.runAllTimersAsync()

    const op = vi.fn(async () => {
      vi.advanceTimersByTime(2)
      return 'ok'
    })

    const p2 = cb.execute(op)
    await vi.runAllTimersAsync()
    await expect(p2).resolves.toBe('ok')

    // Implementation may briefly be HALF_OPEN during execution; after success it should be CLOSED.
    expect(cb.getHealthInfo().state).toBe(CircuitState.CLOSED)
  })

  it('re-opens if HALF_OPEN trial fails', async () => {
    const cb = new CircuitBreaker('svc-i')

    const fail = vi.fn(async () => {
      vi.advanceTimersByTime(1)
      throw new Error('fail')
    })

    for (let i = 0; i < 3; i++) {
      const p = cb.execute(fail)
      await vi.runAllTimersAsync()
      await expect(p).rejects.toBeInstanceOf(Error)
    }

    vi.advanceTimersByTime(60_000)
    await vi.runAllTimersAsync()

    const nope = vi.fn(async () => {
      vi.advanceTimersByTime(2)
      throw new Error('nope')
    })

    const p2 = cb.execute(nope)
    await vi.runAllTimersAsync()
    await expect(p2).rejects.toBeInstanceOf(Error)

    expect(cb.getHealthInfo().state).toBe(CircuitState.OPEN)
  })

  it('withCircuitBreaker wraps an operation and returns its result', async () => {
    const op = vi.fn(async () => {
      vi.advanceTimersByTime(5)
      return 'wrapped'
    })

    const p = withCircuitBreaker('svc-j', op)
    await vi.runAllTimersAsync()
    await expect(p).resolves.toBe('wrapped')
    expect(op).toHaveBeenCalledTimes(1)
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
  })

  it('returns same CircuitBreaker instance for same name', () => {
    const client = new DistributedCircuitBreakerClient()
    const a1 = client.getBreaker('svc-x')
    const a2 = client.getBreaker('svc-x')
    const b = client.getBreaker('svc-y')

    expect(a1).toBe(a2)
    expect(a1).not.toBe(b)
  })

  it('can execute using a named breaker', async () => {
    const client = new DistributedCircuitBreakerClient()
    const op = vi.fn(async () => {
      vi.advanceTimersByTime(3)
      return 42
    })

    const p = client.execute('svc-z', op)
    await vi.runAllTimersAsync()
    await expect(p).resolves.toBe(42)
    expect(op).toHaveBeenCalledTimes(1)

    const info = client.getBreaker('svc-z').getHealthInfo()
    expect(info.metrics.totalCalls).toBe(1)
    expect(info.metrics.successfulCalls).toBe(1)
  })
})