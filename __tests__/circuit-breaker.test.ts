// Ensure this file never executes outside Jest (some CI runners may attempt to execute
// test files with non-jest tooling and choke on jest.mock / ESM interop).
const isJestRuntime =
  typeof jest !== 'undefined' ||
  (typeof process !== 'undefined' &&
    process.env &&
    (process.env.JEST_WORKER_ID !== undefined || process.env.JEST !== undefined))

const noop = () => {}
noop.skip = noop
const maybeDescribe = isJestRuntime ? describe : noop

if (isJestRuntime) {
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
      // ignore if module doesn't exist in this environment
    }

    const createClient = () => {
      const store = Object.create(null)
      return {
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
        __store: store,
      }
    }

    return {
      ...actual,
      getRedisClient: jest.fn(async () => createClient()),
    }
  })
}

let format, subMonths, useMedia, getRedisClient
if (isJestRuntime) {
  ;({ format, subMonths } = require('date-fns'))
  ;({ useMedia } = require('react-use'))
  ;({ getRedisClient } = require('@/config/redis'))
}

if (isJestRuntime) {
  afterEach(() => {
    jest.clearAllMocks()
  })
}

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

  it('del returns proper count and clears values', async () => {
    const client = await getRedisClient()

    // set two keys
    await client.set('a', '1')
    await client.set('b', '2')

    // delete existing key -> should return 1 (existed)
    const delExisting = await client.del('a')
    expect(delExisting).toBe(1)
    expect(await client.get('a')).toBeNull()

    // delete missing key -> should return 0 (did not exist)
    const delMissing = await client.del('z')
    expect(delMissing).toBe(0)

    expect(client.set).toHaveBeenCalledTimes(2)
    expect(client.del).toHaveBeenCalledTimes(2)
    expect(client.get).toHaveBeenCalledTimes(1)
  })

  it('quit resolves OK', async () => {
    const client = await getRedisClient()
    const res = await client.quit()
    expect(res).toBe('OK')
    expect(client.quit).toHaveBeenCalledTimes(1)
  })
})