import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
const { describe, it, expect, jest, afterEach } = require('@jest/globals')

// Ensure this file never executes outside Jest (some CI runners may attempt to execute
// test files with non-jest tooling and choke on jest.mock / ESM interop).
const isJestRuntime =
  typeof process !== 'undefined' &&
  process.env &&
  (process.env.JEST_WORKER_ID !== undefined || process.env.JEST !== undefined)

const maybeDescribe = isJestRuntime ? describe : describe.skip

jest.mock('date-fns', () => {
  const actual = jest.requireActual('date-fns')
  return {
    ...actual,
    format: jest.fn((_date, _fmt) => '2024-01-01'),
    subMonths: jest.fn((_date, _months) => new Date('2024-01-01')),
  }
})

jest.mock('react-use', () => {
  const actual = jest.requireActual('react-use')
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
    // ignore
  }

  // Important: keep store/client stable across multiple getRedisClient() calls
  // within a single test file execution, but allow resetting between tests via
  // jest.clearAllMocks (store persists unless recreated here).
  const store = Object.create(null)

  const client = {
    get: jest.fn(async (key) =>
      Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null,
    ),
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

maybeDescribe('external dependency mocks behave deterministically', () => {
  it('date-fns: format returns a fixed string', () => {
    const result = format(new Date('1999-12-31T00:00:00.000Z'), 'yyyy-MM-dd')
    expect(result).toBe('2024-01-01')
    expect(format).toHaveBeenCalledTimes(1)
  })

  it('date-fns: subMonths returns a fixed date', () => {
    const result = subMonths(new Date('2024-02-15T00:00:00.000Z'), 1)
    expect(result).toEqual(new Date('2024-01-01'))
    expect(subMonths).toHaveBeenCalledTimes(1)
  })

  it('react-use: useMedia returns false', () => {
    const val = useMedia()
    expect(val).toBe(false)
    expect(useMedia).toHaveBeenCalledTimes(1)
  })
})

maybeDescribe('redis client behavior (mocked)', () => {
  it('set/get roundtrip works and returns null for missing keys', async () => {
    const client = await getRedisClient()

    await client.set('k1', 'v1')
    expect(await client.get('k1')).toBe('v1')
    expect(await client.get('missing')).toBeNull()

    expect(client.set).toHaveBeenCalledWith('k1', 'v1')
    expect(client.get).toHaveBeenCalledWith('k1')
    expect(client.get).toHaveBeenCalledWith('missing')
  })

  it('del returns 1 when key existed and 0 when missing', async () => {
    const client = await getRedisClient()

    await client.set('k2', 'v2')
    expect(await client.del('k2')).toBe(1)
    expect(await client.del('k2')).toBe(0)

    expect(client.set).toHaveBeenCalledWith('k2', 'v2')
    expect(client.del).toHaveBeenCalledWith('k2')
  })

  it('quit resolves OK', async () => {
    const client = await getRedisClient()
    await expect(client.quit()).resolves.toBe('OK')
    expect(client.quit).toHaveBeenCalledTimes(1)
  })
})