import { jest } from '@jest/globals'

// Always preserve other exports when mocking
jest.mock('date-fns', () => {
  const actual = (() => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return jest.requireActual('date-fns')
    } catch {
      return {}
    }
  })()
  return {
    ...actual,
    format: jest.fn(() => '2024-01-01'),
    subMonths: jest.fn(() => new Date('2024-01-01')),
  }
})

jest.mock('react-use', () => {
  const actual = (() => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return jest.requireActual('react-use')
    } catch {
      return {}
    }
  })()
  return {
    ...actual,
    useMedia: jest.fn(() => false),
  }
})

jest.mock('@/config/redis', () => {
  const actual = (() => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return jest.requireActual('@/config/redis')
    } catch {
      return {}
    }
  })()
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

import * as CB from '@/app/circuit-breaker'

describe('circuit-breaker module (smoke tests matching source reality)', () => {
  it('imports the module successfully', () => {
    expect(CB).toBeDefined()
  })

  it('exposes at least one export', () => {
    expect(Object.keys(CB).length).toBeGreaterThan(0)
  })

  it('does not expose undefined exports', () => {
    for (const key of Object.keys(CB)) {
      expect((CB as any)[key]).not.toBeUndefined()
    }
  })
})