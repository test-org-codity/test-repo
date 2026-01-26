import { describe, it, expect, jest, afterEach } from '@jest/globals'
import { CircuitBreaker, CircuitBreakerOpenError } from '@/circuit-breaker'

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
  })

  it('execute rejects when operation throws', async () => {
    const cb = new CircuitBreaker('svc-fail', { failureThreshold: 3, slidingWindowSize: 5 })
    const failingOp = jest.fn(async () => {
      throw new Error('boom')
    })
    await expect(cb.execute(failingOp)).rejects.toThrow('boom')
  })
})

describe('CircuitBreakerOpenError', () => {
  it('is an Error with expected name and message containing service name', () => {
    const err = new CircuitBreakerOpenError('svc', 123.6)
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('CircuitBreakerOpenError')
    expect(String(err.message)).toEqual(expect.stringContaining('svc'))
    if ('remainingTimeMs' in err) {
      expect((err as any).remainingTimeMs).toBe(123.6)
    }
  })
})