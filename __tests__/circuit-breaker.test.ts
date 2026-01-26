const { describe, it, expect, jest, afterEach } = require('@jest/globals')

// Ensure this file never executes outside Jest (some CI runners may attempt to execute
// test files with non-jest tooling and choke on jest.mock / ESM interop).
const isJestRuntime =
  typeof process !== 'undefined' &&
  process.env &&
  (process.env.JEST_WORKER_ID !== undefined || process.env.JEST !== undefined)

const maybeDescribe = isJestRuntime ? describe : describe.skip

jest.mock('date-fns', () => ({
  ...jest.requireActual('date-fns'),
  format: jest.fn((_date, _fmt) => '2024-01-01'),
  subMonths: jest.fn((_date, _months) => new Date('2024-01-01')),
}))

jest.mock('react-use', () => ({
  ...jest.requireActual('react-use'),
  useMedia: jest.fn(() => false),
}))

jest.mock('@/config/redis', () => {
  let actual = {}
  try {
    actual = jest.requireActual('@/config/redis')
  } catch (_e) {
    // ignore
  }

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

    expect(client.set).toHaveBeenCalledTimes(1)
    expect(client.get).toHaveBeenCalledTimes(2)
  })

  it('del removes keys and reports existence count', async () => {
    const client = await getRedisClient()

    expect(await client.del('nope')).toBe(0)

    await client.set('k2', 'v2')
    expect(await client.del('k2')).toBe(1)
    expect(await client.get('k2')).toBeNull()

    expect(client.del).toHaveBeenCalledTimes(2)
  })

  it('getRedisClient returns a stable mocked client instance', async () => {
    const c1 = await getRedisClient()
    const c2 = await getRedisClient()

    expect(c1).toBe(c2)
    expect(getRedisClient).toHaveBeenCalledTimes(2)
  })
})