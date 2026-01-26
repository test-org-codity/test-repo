import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals'
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
  jest.mock('date-fns', () => ({
  ...jest.requireActual('date-fns'),
    let actual: any = {}
    try {
      actual = jest.requireActual('date-fns')
    } catch (_e) {
      // Module may not exist in this environment; fall back to just our stubs
    }
    return {
      ...actual,
      format: jest.fn((_date: Date, _fmt: string) => '2024-01-01'),
      subMonths: jest.fn((_date: Date, _months: number) => new Date('2024-01-01T00:00:00.000Z')),
    }
  })

  jest.mock('react-use', () => ({
  ...jest.requireActual('react-use'),
    let actual: any = {}
    try {
      actual = jest.requireActual('react-use')
    } catch (_e) {
      // Module may not exist in this environment; fall back to just our stubs
    }
    return {
      ...actual,
      useMedia: jest.fn(() => false),
    }
  })

  jest.mock('@/config/redis', () => ({
  ...jest.requireActual('@/config/redis'),
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
    if (typeof jest !== 'undefined' && typeof jest.clearAllMocks === 'function') {
      jest.clearAllMocks()
    }
  })
}

maybeDescribe('external dependency mocks', () => {
  it('mocks date-fns: format and subMonths return stable values and record calls', () => {
    const d = new Date('2023-05-15T12:00:00.000Z')
    const out1 = format(d, 'yyyy-MM-dd')
    expect(out1).toBe('2024-01-01')
    expect(typeof format).toBe('function')
    expect(format.mock).toBeDefined()
    expect(format).toHaveBeenCalledTimes(1)
    expect(format).toHaveBeenCalledWith(d, 'yyyy-MM-dd')

    const out2 = subMonths(d, 3)
    expect(out2).toEqual(new Date('2024-01-01T00:00:00.000Z'))
    expect(typeof subMonths).toBe('function')
    expect(subMonths.mock).toBeDefined()
    expect(subMonths).toHaveBeenCalledTimes(1)
    expect(subMonths).toHaveBeenCalledWith(d, 3)
  })

  it('mocks react-use: useMedia returns false and records the query', () => {
    const result = useMedia('(min-width: 768px)')
    expect(result).toBe(false)
    expect(typeof useMedia).toBe('function')
    expect(useMedia.mock).toBeDefined()
    expect(useMedia).toHaveBeenCalledTimes(1)
    expect(useMedia).toHaveBeenCalledWith('(min-width: 768px)')
  })

  it('mocks redis client: set/get/del/quit basic behavior', async () => {
    const client = await getRedisClient()
    expect(typeof client.get).toBe('function')
    expect(typeof client.set).toBe('function')
    expect(typeof client.del).toBe('function')
    expect(typeof client.quit).toBe('function')

    const notFound = await client.get('missing')
    expect(notFound).toBeNull()

    const okSet = await client.set('k', 'v')
    expect(okSet).toBe('OK')

    const got = await client.get('k')
    expect(got).toBe('v')

    const deletedOnce = await client.del('k')
    expect(deletedOnce).toBe(1)

    const deletedTwice = await client.del('k')
    expect(deletedTwice).toBe(0)

    const afterDel = await client.get('k')
    expect(afterDel).toBeNull()

    const quit = await client.quit()
    expect(quit).toBe('OK')
  })

  it('redis mock provides isolated stores per client', async () => {
    const c1 = await getRedisClient()
    const c2 = await getRedisClient()

    await c1.set('a', '1')
    const v1 = await c1.get('a')
    const v2 = await c2.get('a')

    expect(v1).toBe('1')
    expect(v2).toBeNull()

    // ensure the mocked methods recorded calls
    expect(c1.set).toHaveBeenCalledWith('a', '1')
    expect(c1.get).toHaveBeenCalledWith('a')
    expect(c2.get).toHaveBeenCalledWith('a')
  })
})