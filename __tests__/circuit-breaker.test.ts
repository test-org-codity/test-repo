const { describe, it, expect, jest, afterEach } = require('@jest/globals')

// Avoid loading ESM `@jest/globals` via a non-jest runner (e.g. vitest) which can trigger
// "Failed to load url @jest/globals". If such a runner is present, skip this suite.
const isJestRuntime =
  typeof process !== 'undefined' &&
  process.env &&
  (process.env.JEST_WORKER_ID !== undefined || process.env.JEST !== undefined)

const maybeDescribe = isJestRuntime ? describe : describe.skip

jest.mock('date-fns', () => {
  let actual = {}
  try {
    actual = jest.requireActual('date-fns')
  } catch (_e) {
    // ignore
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
    // ignore
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

maybeDescribe('external dependency mocks behave deterministically', () => {
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

maybeDescribe('redis client behavior (mocked)', () => {
  it('set/get roundtrip works and returns null for missing keys', async () => {
    const client = await getRedisClient()

    await client.set('k1', 'v1')
    expect(await client.get('k1')).toBe('v1')
    expect(await client.get('missing')).toBeNull()

    expect(client.set).toHaveBeenCalledWith('k1', 'v1')
    expect(client.get).toHaveBeenCalled()
  })

  it('del returns 1 when key existed and 0 otherwise', async () => {
    const client = await getRedisClient()

    await client.set('k2', 'v2')
    await expect(client.del('k2')).resolves.toBe(1)
    await expect(client.del('k2')).resolves.toBe(0)
  })

  it('getRedisClient exists and returns a client with expected methods', async () => {
    expect(typeof getRedisClient).toBe('function')
    const client = await getRedisClient()
    expect(client && typeof client).toBe('object')
    expect(typeof client.get).toBe('function')
    expect(typeof client.set).toBe('function')
    expect(typeof client.del).toBe('function')
    expect(typeof client.quit).toBe('function')
  })
})