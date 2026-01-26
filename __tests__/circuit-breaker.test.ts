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

let format: any
let subMonths: any
let useMedia: any
let getRedisClient: any

if (isJestRuntime) {
  // Mock date-fns while preserving other exports
  jest.mock('date-fns', () => ({
    ...(jest.requireActual('date-fns') as any),
    format: jest.fn((_date: Date, _fmt: string) => '2024-01-01'),
    subMonths: jest.fn(
      (_date: Date, _months: number) => new Date('2024-01-01T00:00:00.000Z'),
    ),
  }))

  // Mock react-use while preserving other exports
  jest.mock('react-use', () => ({
    ...(jest.requireActual('react-use') as any),
    useMedia: jest.fn(() => false),
  }))

  // Mock redis client while preserving other exports
  jest.mock(
    '@/config/redis',
    () => {
      const actual: any = jest.requireActual('@/config/redis')

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
    },
    { virtual: true } as any,
  )

  // Re-require mocked modules into local vars for direct inspection if needed
  ;({ format, subMonths } = jest.requireMock('date-fns'))
  ;({ useMedia } = jest.requireMock('react-use'))
  ;({ getRedisClient } = jest.requireMock('@/config/redis'))
}

maybeDescribe('infrastructure sanity tests', () => {
  it('date-fns mocks behave as expected', () => {
    const d = new Date('2023-05-05T00:00:00.000Z')
    expect(typeof format).toBe('function')
    expect(format(d, 'yyyy-MM-dd')).toBe('2024-01-01')
    const sub = subMonths(d, 2)
    expect(sub).toBeInstanceOf(Date)
    expect(sub.toISOString()).toBe('2024-01-01T00:00:00.000Z')
  })

  it('react-use useMedia mock behaves as expected', () => {
    expect(typeof useMedia).toBe('function')
    expect(useMedia('(min-width: 768px)')).toBe(false)
  })

  it('redis mock client behaves as expected', async () => {
    const client = await getRedisClient()
    expect(client).toBeDefined()
    expect(typeof client.get).toBe('function')
    expect(typeof client.set).toBe('function')
    expect(typeof client.del).toBe('function')

    const key = 'test-key'
    const value = 'test-value'

    const initial = await client.get(key)
    expect(initial).toBeNull()

    const setRes = await client.set(key, value)
    expect(setRes).toBe('OK')

    const afterSet = await client.get(key)
    expect(afterSet).toBe(value)

    const delRes = await client.del(key)
    expect(delRes).toBe(1)

    const afterDel = await client.get(key)
    expect(afterDel).toBeNull()
  })

  it('jest globals are available and consistent', () => {
    expect(typeof describe).toBe('function')
    expect(typeof it).toBe('function')
    expect(typeof expect).toBe('function')
    expect(typeof jest).toBe('object')
  })
})