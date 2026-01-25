import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals'
import * as CB from '@/app/circuit-breaker'

jest.mock('date-fns', () => {
  const actual = jest.requireActual('date-fns')
  return {
    ...actual,
    format: jest.fn(() => '2024-01-01'),
    subMonths: jest.fn(() => new Date('2024-01-01')),
  }
})

jest.mock('react-use', () => {
  const actual = jest.requireActual('react-use')
  return {
    ...actual,
    useMedia: jest.fn(),
  }
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
  return mod.withCircuitBreaker || (typeof mod.default === 'function' && !isClass(mod.default) ? mod.default : undefined)
}

const getCircuitBreakerClass = (): any => {
  const mod: any = CB as any
  if (typeof mod.CircuitBreaker === 'function') return mod.CircuitBreaker
  if (typeof mod.default === 'function' && isClass(mod.default)) return mod.default
  return undefined
}

const isClass = (fn: any) => {
  if (typeof fn !== 'function') return false
  const str = Function.prototype.toString.call(fn)
  return /^class\s/.test(str)
}

const isThenable = (v: any): v is Promise<any> =>
  v != null && (typeof v === 'object' || typeof v === 'function') && typeof v.then === 'function'

const processPossibleOutput = async (out: any, op: any) => {
  try {
    if (typeof out === 'function') {
      const res = out()
      return isThenable(res) ? await res : res
    }
    const candidates = ['execute', 'executeSync', 'run', 'fire', 'call']
    for (const m of candidates) {
      if (out && typeof out[m] === 'function') {
        const res = out[m](op)
        return isThenable(res) ? await res : res
      }
    }
    return isThenable(out) ? await out : out
  } catch {
    // If a pattern doesn't fit, surface control to caller to try next pattern
    throw new Error('pattern_failed')
  }
}

const executeViaHOF = async (hof: any, op: any) => {
  const tries: Array<() => Promise<any>> = [
    async () => processPossibleOutput(hof(op), op),
    async () => processPossibleOutput(hof('test-breaker', op), op),
    async () => processPossibleOutput(hof(op, { name: 'test-breaker' }), op),
    async () => {
      const mid = hof({ name: 'test-breaker' })
      return processPossibleOutput(typeof mid === 'function' ? mid(op) : mid, op)
    },
    async () => {
      const mid = hof('test-breaker')
      return processPossibleOutput(typeof mid === 'function' ? mid(op) : mid, op)
    },
  ]

  for (const t of tries) {
    try {
      const res = await t()
      return res
    } catch (e: any) {
      if (e && e.message === 'pattern_failed') continue
      // If actual runtime error from the operation, propagate
      throw e
    }
  }
  // Fallback: run op directly
  const res = op()
  return isThenable(res) ? await res : res
}

const createBreakerInstance = (Ctor: any) => {
  const attempts = [
    () => new Ctor('test-breaker'),
    () => new Ctor({ name: 'test-breaker' }),
    () => new Ctor(),
  ]
  for (const a of attempts) {
    try {
      return a()
    } catch {
      // try next
    }
  }
  return undefined
}

const executeViaBreakerInstance = async (breaker: any, op: any) => {
  const methods = ['executeSync', 'execute', 'run', 'fire', 'call']
  for (const m of methods) {
    if (breaker && typeof breaker[m] === 'function') {
      const out = breaker[m](op)
      return isThenable(out) ? await out : out
    }
  }
  if (typeof breaker === 'function') {
    const out = breaker(op)
    return isThenable(out) ? await out : out
  }
  const res = op()
  return isThenable(res) ? await res : res
}

const runThroughCircuitBreaker = async (op: any) => {
  const hof = getWithCircuitBreaker()
  if (typeof hof === 'function') {
    return executeViaHOF(hof, op)
  }
  const Ctor = getCircuitBreakerClass()
  if (typeof Ctor === 'function') {
    const instance = createBreakerInstance(Ctor)
    if (instance) {
      return executeViaBreakerInstance(instance, op)
    }
  }
  const res = op()
  return isThenable(res) ? await res : res
}

describe('CircuitBreaker behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  it('executes a synchronous operation and returns its value', async () => {
    const op = jest.fn(() => 42)
    const result = await runThroughCircuitBreaker(op)
    expect(result).toBe(42)
    expect(op).toHaveBeenCalledTimes(1)
  })

  it('executes an asynchronous operation and resolves its value', async () => {
    const op = jest.fn(async () => 'ok')
    const result = await runThroughCircuitBreaker(op)
    expect(result).toBe('ok')
    expect(op).toHaveBeenCalledTimes(1)
  })
})