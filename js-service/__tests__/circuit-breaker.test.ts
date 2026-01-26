import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('@/config', async () => {
  const actual = await vi.importActual<any>('@/config').catch(() => ({}))
  return { ...actual }
})

vi.mock('@/app/logger', async () => {
  const actual = await vi.importActual<any>('@/app/logger').catch(() => ({}))
  const noop = () => undefined
  const logger =
    actual?.logger ??
    actual?.default ?? {
      debug: noop,
      info: noop,
      warn: noop,
      error: noop,
      child: () => logger,
    }
  return {
    ...actual,
    logger,
    default: logger,
  }
})

vi.mock('@/app/metrics', async () => {
  const actual = await vi.importActual<any>('@/app/metrics').catch(() => ({}))
  return { ...actual }
})

vi.mock('@/app/tracing', async () => {
  const actual = await vi.importActual<any>('@/app/tracing').catch(() => ({}))
  return { ...actual }
})

vi.mock('@/app/telemetry', async () => {
  const actual = await vi.importActual<any>('@/app/telemetry').catch(() => ({}))
  return { ...actual }
})

vi.mock('@/app/redis', async () => {
  const actual = await vi.importActual<any>('@/app/redis').catch(() => ({}))
  return { ...actual }
})

vi.mock('@/app/kv', async () => {
  const actual = await vi.importActual<any>('@/app/kv').catch(() => ({}))
  return { ...actual }
})

vi.mock('@/app/distributed-lock', async () => {
  const actual = await vi.importActual<any>('@/app/distributed-lock').catch(() => ({}))
  return { ...actual }
})

import { CircuitBreaker, CircuitBreakerOpenError, withCircuitBreaker } from '@/app/circuit-breaker'

describe('circuit-breaker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2020-01-01T00:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('CircuitBreaker.execute returns operation result on success', async () => {
    const cb = new CircuitBreaker('svc-success' as any)
    const op = vi.fn(async () => 'ok')

    const p = cb.execute(op)
    await vi.runAllTimersAsync()
    const result = await p

    expect(result).toBe('ok')
    expect(op).toHaveBeenCalledTimes(1)
  })

  it('CircuitBreaker.execute rethrows original error on failure', async () => {
    const cb = new CircuitBreaker('svc-fail' as any)
    const err = new Error('boom')
    const op = vi.fn(async () => {
      throw err
    })

    const p = cb.execute(op)
    await vi.runAllTimersAsync()

    await expect(p).rejects.toBe(err)
    expect(op).toHaveBeenCalledTimes(1)
  })

  it('CircuitBreaker.executeSync returns operation result on success', () => {
    const cb = new CircuitBreaker('svc-sync-success' as any)
    const op = vi.fn(() => 123)

    const result = cb.executeSync(op)

    expect(result).toBe(123)
    expect(op).toHaveBeenCalledTimes(1)
  })

  it('CircuitBreaker.executeSync rethrows original error on failure', () => {
    const cb = new CircuitBreaker('svc-sync-fail' as any)
    const err = new Error('fail')
    const op = vi.fn(() => {
      throw err
    })

    expect(() => cb.executeSync(op)).toThrow(err)
    expect(op).toHaveBeenCalledTimes(1)
  })

  it('withCircuitBreaker wraps an async function and passes through return value', async () => {
    const wrapped = withCircuitBreaker('svc-wrap' as any, async (a: number, b: number) => a + b)
    const p = wrapped(2, 3)
    await vi.runAllTimersAsync()
    await expect(p).resolves.toBe(5)
  })

  it('CircuitBreakerOpenError is an Error and can be instantiated', () => {
    const e = new CircuitBreakerOpenError('open')
    expect(e).toBeInstanceOf(Error)
    expect(String(e.message)).toContain('open')
  })
})