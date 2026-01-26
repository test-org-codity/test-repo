/* eslint-disable @typescript-eslint/no-explicit-any */

// Minimal ambient declarations to satisfy TypeScript without relying on external test type packages.
declare const describe: any
declare const it: any
declare const expect: any
declare const beforeEach: any
declare const afterEach: any
declare const jest: any

// Ensure this file never executes outside Jest (some CI runners may attempt to execute
// test files with non-jest tooling and choke on jest.mock / ESM interop).
const isJestRuntime =
  typeof jest !== 'undefined' ||
  (typeof process !== 'undefined' &&
    process.env &&
    (process.env.JEST_WORKER_ID !== undefined || process.env.JEST !== undefined))

const noop: any = () => {}
noop.skip = noop
const maybeDescribe: any = isJestRuntime && typeof describe === 'function' ? describe : noop

if (isJestRuntime) {
  jest.mock('date-fns', () => {
    const actual = jest.requireActual('date-fns')
    return {
      ...actual,
      format: jest.fn((_date: Date, _fmt: string) => '2024-01-01'),
      subMonths: jest.fn((_date: Date, _months: number) => new Date('2024-01-01')),
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

let format: any
let subMonths: any
let useMedia: any
let getRedisClient: any

if (isJestRuntime) {
  ;({ format, subMonths } = require('date-fns'))
  ;({ useMedia } = require('react-use'))
  ;({ getRedisClient } = require('@/config/redis'))
}

if (isJestRuntime && typeof afterEach === 'function') {
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

maybeDescribe('redis client mock behaves like naive in-memory redis', () => {
  it('supports set/get/del/quit with expected results', async () => {
    const client = await getRedisClient()

    const g1 = await client.get('key')
    expect(g1).toBeNull()

    const s1 = await client.set('key', 'value')
    expect(s1).toBe('OK')
    expect(client.set).toHaveBeenCalledTimes(1)

    const g2 = await client.get('key')
    expect(g2).toBe('value')
    expect(client.get).toHaveBeenCalledTimes(2) // one before set, one after set

    const d1 = await client.del('key')
    expect(d1).toBe(1)
    expect(client.del).toHaveBeenCalledTimes(1)

    const g3 = await client.get('key')
    expect(g3).toBeNull()

    const d2 = await client.del('key')
    expect(d2).toBe(0)

    const q = await client.quit()
    expect(q).toBe('OK')
    expect(client.quit).toHaveBeenCalledTimes(1)
  })

  it('creates isolated client instances (separate in-memory stores)', async () => {
    const clientA = await getRedisClient()
    const clientB = await getRedisClient()

    await clientA.set('onlyA', 'A')
    const aGetA = await clientA.get('onlyA')
    const bGetA = await clientB.get('onlyA')

    expect(aGetA).toBe('A')
    expect(bGetA).toBeNull()

    await clientB.set('onlyB', 'B')
    const aGetB = await clientA.get('onlyB')
    const bGetB = await clientB.get('onlyB')

    expect(aGetB).toBeNull()
    expect(bGetB).toBe('B')

    // verify the internal stores reflect isolation
    expect(Object.keys(clientA.__store)).toEqual(['onlyA'])
    expect(Object.keys(clientB.__store)).toEqual(['onlyB'])
  })
})