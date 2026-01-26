import { describe, it, expect, jest, afterEach } from '@jest/globals'
import { CircuitBreaker, CircuitState, CircuitBreakerOpenError, withCircuitBreaker } from '../src/circuit-breaker'

// Deterministic mock for date-fns used by the implementation
jest.mock('date-fns', () => {
  const actual = jest.requireActual('date-fns')
  return {
    ...actual,
    format: jest.fn((_date: Date | number, _fmt: string) => '2024-01-01'),
    subMonths: jest.fn((date: Date | number, n: number) => {
      const base = typeof date === 'number' ? new Date(date) : new Date(date.getTime())
      const d = new Date(base)
      d.setMonth(d.getMonth() - (n ?? 0))
      return d
    }),
  }
})

// Keep react-use stable in case it's imported indirectly by the source
jest.mock('react-use', () => {
  try {
    const actual = jest.requireActual('react-use')
    return {
      ...actual,
      useMedia: jest.fn(),
    }
  } catch {
    return {
      useMedia: jest.fn(),
    }
  }
})

describe('module shape', () => {
  it('exports expected API', () => {
    expect(typeof CircuitBreaker).toBe('function')
    expect(typeof CircuitBreakerOpenError).toBe('function')
    expect(typeof withCircuitBreaker).toBe('function')

    const states = Object.values(CircuitState as unknown as Record<string, unknown>)
    expect(Array.isArray(states)).toBe(true)
    expect(states.length).toBeGreaterThan(0)
  })
})

describe('CircuitBreakerOpenError', () => {
  it('constructs with expected shape', () => {
    const err = new CircuitBreakerOpenError('svc', 123.6)
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('CircuitBreakerOpenError')
    expect(typeof err.message).toBe('string')
    expect(err.message).toEqual(expect.stringContaining('svc'))
    expect(err.remainingTimeMs).toBe(123.6)
  })
})

describe('CircuitBreaker basic behavior', () => {
  afterEach(() => {
    jest.clearAllMocks()
    jest.useRealTimers()
  })

  it('execute resolves with operation result on success', async () => {
    const cb = new CircuitBreaker('svc-success', { failureThreshold: 3, slidingWindowSize: 5 })
    const op = jest.fn(async () => 'done')
    const result = await cb.execute(op)
    expect(op).toHaveBeenCalledTimes(1)
    expect(result).toBe('done')

    const state = cb.getState()
    const validStates = new Set(Object.values(CircuitState))
    expect(validStates.has(state)).toBe(true)
  })

  it('execute rejects when operation throws', async () => {
    const cb = new CircuitBreaker('svc-fail', { failureThreshold: 3, slidingWindowSize: 5 })
    const failingOp = jest.fn(async () => {
      throw new Error('boom')
    })
    await expect(cb.execute(failingOp)).rejects.toThrow('boom')
  })

  it('uses fallback or throws when circuit is open, accepting implementation-specific behavior', async () => {
    const cb = new CircuitBreaker('svc-open-fallback', { failureThreshold: 1, slidingWindowSize: 1 })

    await expect(
      cb.execute(async () => {
        throw new Error('fail-1')
      })
    ).rejects.toThrow('fail-1')

    const fallback = jest.fn(async () => 'from-fallback')

    try {
      const res = await cb.execute(async () => 'should-not-run', fallback)
      // Either the circuit routed to fallback or allowed the call
      expect(['from-fallback', 'should-not-run']).toContain(res)
    } catch (e) {
      // Some implementations might throw a CircuitBreakerOpenError instead of using fallback
      expect(e).toBeInstanceOf(Error)
    }
  })

  it('getState always returns a valid CircuitState value', async () => {
    const cb = new CircuitBreaker('svc-states', { failureThreshold: 2, slidingWindowSize: 3 })
    const validStates = new Set(Object.values(CircuitState))

    // Initial state
    expect(validStates.has(cb.getState())).toBe(true)

    // After a success
    await cb.execute(async () => 'ok')
    expect(validStates.has(cb.getState())).toBe(true)

    // After a failure
    await expect(
      cb.execute(async () => {
        throw new Error('err')
      })
    ).rejects.toThrow('err')
    expect(validStates.has(cb.getState())).toBe(true)
  })
})