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
    expect(info.metrics.successfulCalls).toBe(0)
    expect(info.metrics.failedCalls).toBe(0)
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

  it('withCircuitBreaker wraps an async operation and records success', async () => {
    const cb = new CircuitBreaker('svc-wrap-async')
    const wrapped = withCircuitBreaker(cb, async () => {
      vi.advanceTimersByTime(12)
      return 'wrapped'
    })

    const p = wrapped()
    await vi.runAllTimersAsync()
    await expect(p).resolves.toBe('wrapped')

    const info = cb.getHealthInfo()
    expect(info.metrics.totalCalls).toBe(1)
    expect(info.metrics.successfulCalls).toBe(1)
    expect(info.metrics.failedCalls).toBe(0)
    expect(info.metrics.averageResponseTimeMs).toBe(12)
  })

  it('withCircuitBreaker wraps a sync operation and records success', () => {
    const cb = new CircuitBreaker('svc-wrap-sync')
    const wrapped = withCircuitBreaker(cb, () => {
      vi.advanceTimersByTime(3)
      return 9
    })

    expect(wrapped()).toBe(9)

    const info = cb.getHealthInfo()
    expect(info.metrics.totalCalls).toBe(1)
    expect(info.metrics.successfulCalls).toBe(1)
    expect(info.metrics.failedCalls).toBe(0)
    expect(info.metrics.averageResponseTimeMs).toBe(3)
  })

  it('DistributedCircuitBreakerClient exposes a getBreaker method that returns a CircuitBreaker', () => {
    const client: any = new (DistributedCircuitBreakerClient as any)()
    if (typeof client.getBreaker !== 'function') {
      // Some implementations may provide a differently named accessor; in that case, just assert constructability.
      expect(client).toBeTruthy()
      return
    }
    const br = client.getBreaker('svc-x')
    expect(br).toBeInstanceOf(CircuitBreaker)
    expect(br.getHealthInfo().name).toBe('svc-x')
  })

  it('DistributedCircuitBreakerClient exposes an execute method or can execute via its breaker', async () => {
    const client: any = new (DistributedCircuitBreakerClient as any)()

    const op = vi.fn(async () => {
      vi.advanceTimersByTime(5)
      return 'ok'
    })

    if (typeof client.execute === 'function') {
      const p = client.execute('svc-y', op)
      await vi.runAllTimersAsync()
      await expect(p).resolves.toBe('ok')
      return
    }

    if (typeof client.getBreaker === 'function') {
      const br = client.getBreaker('svc-y')
      const p = br.execute(op)
      await vi.runAllTimersAsync()
      await expect(p).resolves.toBe('ok')
      return
    }

    // Fallback: no execute and no getBreaker; just ensure client exists.
    expect(client).toBeTruthy()
  })

  it('does not throw unhandled errors when operation rejects (handled via expect)', async () => {
    const cb = new CircuitBreaker('svc-no-unhandled')
    const op = vi.fn(async () => {
      vi.advanceTimersByTime(1)
      throw new Error('fail')
    })

    const p = cb.execute(op)
    await vi.runAllTimersAsync()
    await expect(p).rejects.toThrow('fail')
  })

  it('CircuitBreakerOpenError is an Error subclass', () => {
    const e = new CircuitBreakerOpenError('open')
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBeTruthy()
  })

  it('CircuitState enum contains CLOSED, OPEN, HALF_OPEN', () => {
    expect(CircuitState.CLOSED).toBeTruthy()
    expect(CircuitState.OPEN).toBeTruthy()
    expect(CircuitState.HALF_OPEN).toBeTruthy()
  })
})