const { describe, it, expect, jest, afterEach } = require('@jest/globals')

jest.mock('date-fns', () => {
  let actual = {}
  try {
    actual = jest.requireActual('date-fns')
  } catch (_e) {
    // ignore if actual cannot be resolved
  }
  return {
    ...actual,
    format: jest.fn((_date, _fmt) => '2024-01-01'),
    subMonths: jest.fn((_date, _months) => new Date('2024-01-01')),
  }
})

jest.mock('react-use', () => {
  let actual = {}
  try {
    actual = jest.requireActual('react-use')
  } catch (_e) {
    // ignore if actual cannot be resolved
  }
  return {
    ...actual,
    useMedia: jest.fn(() => false),
  }
})

jest.mock('@/config/redis', () => {
  let actual = {}
  try {
    actual = jest.requireActual('@/config/redis')
  } catch (_e) {
    // ignore if actual cannot be resolved
  }
  const store = {}
  const client = {
    get: jest.fn(async (key) => (Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null)),
    set: jest.fn(async (key, value) => {
      store[key] = value
      return 'OK'
    }),
    del: jest.fn(async (key) => {
      const existed = Object.prototype.hasOwnProperty.call(store, key) ? 1 : 0
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

const { format, subMonths } = require('date-fns')
const { useMedia } = require('react-use')
const { getRedisClient } = require('@/config/redis')

afterEach(() => {
  jest.clearAllMocks()
})

describe('external dependency mocks behave deterministically', () => {
  it('date-fns: format returns a fixed string', () => {
    const result = format(new Date('1999-12-31'), 'yyyy-MM-dd')
    expect(result).toBe('2024-01-01')
    expect(format).toHaveBeenCalled()
  })

  it('date-fns: subMonths returns a fixed date', () => {
    const result = subMonths(new Date('2024-02-15'), 1)
    expect(result).toEqual(new Date('2024-01-01'))
    expect(subMonths).toHaveBeenCalled()
  })

  it('react-use: useMedia returns false', () => {
    const val = useMedia()
    expect(val).toBe(false)
    expect(useMedia).toHaveBeenCalled()
  })
})

describe('redis client behavior (mocked)', () => {
})