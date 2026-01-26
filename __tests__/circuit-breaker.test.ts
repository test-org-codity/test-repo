import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals'
jest.mock('date-fns', () => ({
  ...jest.requireActual('date-fns'),
  let actual = {}
  try {
    actual = jest.requireActual('date-fns')
  } catch {
    // ignore if actual cannot be resolved; we only need to provide the mocked API
  }
  return {
    ...actual,
    format: jest.fn((_date, _fmt) => '2024-01-01'),
    subMonths: jest.fn((_date, _months) => new Date('2024-01-01')),
  }
})

jest.mock('react-use', () => ({
  ...jest.requireActual('react-use'),
  let actual = {}
  try {
    actual = jest.requireActual('react-use')
  } catch {
    // ignore if actual cannot be resolved; we only need to provide the mocked API
  }
  return {
    ...actual,
    useMedia: jest.fn(() => false),
  }
})

jest.mock('@/config/redis', () => ({
  ...jest.requireActual('@/config/redis'),
  let actual = {}
  try {
    actual = jest.requireActual('@/config/redis')
  } catch {
    // ignore if actual cannot be resolved; we only need to provide the mocked API
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
  it('set/get/del/quit roundtrip works as expected', async () => {
    const client = await getRedisClient()
    const key = `cb:test:${Math.random().toString(36).slice(2)}`
    const value = 'some-value'

    await expect(client.get(key)).resolves.toBeNull()
    await expect(client.set(key, value)).resolves.toBe('OK')
    await expect(client.get(key)).resolves.toBe(value)
    await expect(client.del(key)).resolves.toBe(1)
    await expect(client.get(key)).resolves.toBeNull()
    await expect(client.quit()).resolves.toBe('OK')
  })
})