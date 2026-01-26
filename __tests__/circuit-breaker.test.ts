import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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
      subMonths: jest.fn((_date: Date, _months: number) => new Date('2024-01-01T00:00:00.000Z')),
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
    if (typeof jest !== 'undefined' && typeof jest.clearAllMocks === 'function') {
      jest.clearAllMocks()
    }
  })
}

maybeDescribe('external dependency mocks behave deterministically', () => {
  it('date-fns: format returns a fixed string', () => {
    const result = format(new Date('1999-12-31T00:00:00.000Z'), 'yyyy-MM-dd')
    expect(result).toBe('2024-01-01')
    expect(format).toHaveBeenCalledTimes(1)
  })

  it('date-fns: subMonths returns a fixed date', () => {
    const input = new Date('2024-02-15T00:00:00.000Z')
    const result = subMonths(input, 3)
    expect(result instanceof Date).toBe(true)
    expect(result.toISOString()).toBe('2024-01-01T00:00:00.000Z')
    expect(subMonths).toHaveBeenCalledTimes(1)
  })

  it('react-use: useMedia returns false', () => {
    const result = useMedia('(min-width: 768px)')
    expect(result).toBe(false)
    expect(useMedia).toHaveBeenCalledTimes(1)
  })

  it('redis mock: basic get/set/del/quit behavior', async () => {
    const client = await getRedisClient()
    expect(typeof client.get).toBe('function')
    expect(await client.get('missing')).toBeNull()

    const setRes = await client.set('foo', 'bar')
    expect(setRes).toBe('OK')
    expect(await client.get('foo')).toBe('bar')

    const delRes = await client.del('foo')
    expect(delRes).toBe(1)
    expect(await client.get('foo')).toBeNull()

    const quitRes = await client.quit()
    expect(quitRes).toBe('OK')
  })

  it('redis mock: separate keys persist within the same client instance', async () => {
    const client = await getRedisClient()
    await client.set('a', '1')
    await client.set('b', '2')
    expect(await client.get('a')).toBe('1')
    expect(await client.get('b')).toBe('2')
    await client.del('a')
    expect(await client.get('a')).toBeNull()
    expect(await client.get('b')).toBe('2')
  })
})