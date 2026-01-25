import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals'
import * as CB from '@/app/circuit-breaker'

jest.mock('date-fns', () => {
  const actual = jest.requireActual('date-fns')
  return { ...actual }
})

jest.mock('@/config/redis', () => {
  const actual = jest.requireActual('@/config/redis')
  const store: Record<string, string> = {}
  const client = {
    get: jest.fn(async (key: string) => (key in store ? store[key] : null)),
    set: jest.fn(async (key: string, value: string) => {
      store[key] = value
      return 'OK'
    }),
    del: jest.fn(async (key: string) => {
      const existed = key in store ? 1 : 0
      delete store[key]
      return existed
    }),
    quit: jest.fn(async () => 'OK'),
  }
  return {
    ...actual,
    getRedisClient: jest.fn().mockResolvedValue(client),
  }
})

const getWithCircuitBreaker = (): any => {
  const mod: any = CB as any
  return mod.withCircuitBreaker || (typeof mod.default === 'function' ? mod.default : undefined)
}

const getCircuitBreakerClass = (): any => {
  const mod: any = CB as any
  return mod.CircuitBreaker || (mod.default && typeof mod.default === 'function' ? mod.default : undefined)
}

describe('CircuitBreaker basic behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  it('executes a sync operation successfully via withCircuitBreaker or CircuitBreaker', async () => {
    const withCircuitBreaker: any = getWithCircuitBreaker()
    let result: any

    if (typeof withCircuitBreaker === 'function') {
      const maybeWrapped = withCircuitBreaker(() => 'ok', { name: 'test-sync' } as any)
      const output = typeof maybeWrapped === 'function' ? maybeWrapped() : maybeWrapped
      result = output && typeof (output as any).then === 'function' ? await output : output
    }

    if (result === undefined) {
      const CircuitBreaker: any = getCircuitBreakerClass()
      if (typeof CircuitBreaker === 'function') {
        const br = new CircuitBreaker('test-sync')
        if (typeof br.executeSync === 'function') {
          result = br.executeSync(() => 'ok')
        } else if (typeof br.execute === 'function') {
          const out = br.execute(async () => 'ok')
          result = out && typeof out.then === 'function' ? await out : out
        }
      }
    }

    expect(result).toBe('ok')
  })

  it('executes an async operation successfully via withCircuitBreaker or CircuitBreaker', async () => {
    const withCircuitBreaker: any = getWithCircuitBreaker()
    let result: any

    const asyncOp = async () => {
      return Promise.resolve('async-ok')
    }

    if (typeof withCircuitBreaker === 'function') {
      const maybeWrapped = withCircuitBreaker(asyncOp, { name: 'test-async' } as any)
      const output = typeof maybeWrapped === 'function' ? maybeWrapped() : maybeWrapped
      result = output && typeof (output as any).then === 'function' ? await output : output
    }

    if (result === undefined) {
      const CircuitBreaker: any = getCircuitBreakerClass()
      if (typeof CircuitBreaker === 'function') {
        const br = new CircuitBreaker('test-async')
        if (typeof br.execute === 'function') {
          const out = br.execute(asyncOp)
          result = out && typeof out.then === 'function' ? await out : out
        } else if (typeof br.executeSync === 'function') {
          result = br.executeSync(() => 'async-ok')
        }
      }
    }

    expect(result).toBe('async-ok')
  })

  it('propagates errors from a failing operation when no fallback is provided', async () => {
    const withCircuitBreaker: any = getWithCircuitBreaker()
    let capturedError: any

    const failingSync = () => {
      throw new Error('boom')
    }
    const failingAsync = async () => {
      throw new Error('boom')
    }

    if (typeof withCircuitBreaker === 'function') {
      const maybeWrapped = withCircuitBreaker(failingSync, { name: 'test-fail' } as any)
      try {
        const output = typeof maybeWrapped === 'function' ? maybeWrapped() : maybeWrapped
        if (output && typeof (output as any).then === 'function') {
          await output
        }
      } catch (err) {
        capturedError = err
      }
    }

    if (!capturedError) {
      const CircuitBreaker: any = getCircuitBreakerClass()
      if (typeof CircuitBreaker === 'function') {
        const br = new CircuitBreaker('test-fail')
        if (typeof br.executeSync === 'function') {
          try {
            br.executeSync(failingSync)
          } catch (err) {
            capturedError = err
          }
        } else if (typeof br.execute === 'function') {
          try {
            await br.execute(failingAsync)
          } catch (err) {
            capturedError = err
          }
        }
      }
    }

    expect(capturedError instanceof Error).toBe(true)
  })
})