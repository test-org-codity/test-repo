// Ensure this file never executes outside Jest (some CI runners may attempt to execute
// test files with non-jest tooling and choke on jest.mock / ESM interop).
const isJestRuntime =
  typeof jest !== 'undefined' ||
  (typeof process !== 'undefined' &&
    process.env &&
    (process.env.JEST_WORKER_ID !== undefined || process.env.JEST !== undefined))

const noop: any = () => {}
noop.skip = noop
const maybeDescribe: typeof describe = isJestRuntime ? describe : (noop as any)

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
    let actual: any = {}
    try {
      actual = jest.requireActual('@/config/redis')
    } catch (_e) {
      // ignore if module doesn't exist in this environment
    }

    const createClient = () => {
      const store: Record<string, string> = Object.create(null)
      return {
        get: jest.fn(async (key: string) =>
          Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null,
        ),
        set: jest.fn(async (key: string, value: string) => {
          store[key] = value
          return 'OK'
        }),
        del: jest.fn(async (key: string) => {
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

let format: any, subMonths: any, useMedia: any, getRedisClient: any
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

    expect(await client.get('missing')).toBeNull()

    await client.set('k1', 'v1')
    expect(await client.get('k1')).toBe('v1')

    expect(await client.del('k1')).toBe(1)
    expect(await client.get('k1')).toBeNull()

    expect(await client.quit()).toBe('OK')

    expect(client.set).toHaveBeenCalledTimes(1)
    expect(client.get).toHaveBeenCalledTimes(3)
    expect(client.del).toHaveBeenCalledTimes(1)
    expect(client.quit).toHaveBeenCalledTimes(1)
  })

  it('separate clients do not share state', async () => {
    const c1 = await getRedisClient()
    const c2 = await getRedisClient()

    await c1.set('onlyC1', 'value1')
    expect(await c1.get('onlyC1')).toBe('value1')
    expect(await c2.get('onlyC1')).toBeNull()

    await c2.set('onlyC2', 'value2')
    expect(await c2.get('onlyC2')).toBe('value2')
    expect(await c1.get('onlyC2')).toBeNull()
  })
})