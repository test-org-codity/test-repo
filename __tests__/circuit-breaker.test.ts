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

  jest.mock('react-use', () => {
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
  })

  it('date-fns: subMonths returns a fixed date instance', () => {
    const result = subMonths(new Date('2020-06-15T00:00:00.000Z'), 3)
    expect(result).toBeInstanceOf(Date)
    expect(result.toISOString()).toBe('2024-01-01T00:00:00.000Z')
  })

  it('react-use: useMedia is mocked and returns false', () => {
    const value = useMedia('(min-width: 768px)')
    expect(value).toBe(false)
    expect(typeof useMedia).toBe('function')
  })

  it('redis: getRedisClient provides isolated in-memory store', async () => {
    const clientA = await getRedisClient()
    const clientB = await getRedisClient()

    // A: set/get
    await clientA.set('k', 'v')
    await clientA.set('x', 'y')
    expect(await clientA.get('k')).toBe('v')
    expect(await clientA.get('x')).toBe('y')

    // B: should be empty initially
    expect(await clientB.get('k')).toBeNull()
    expect(await clientB.get('x')).toBeNull()

    // Delete in A
    const delCount = await clientA.del('k')
    expect(delCount).toBe(1)
    expect(await clientA.get('k')).toBeNull()

    // Quit does not throw
    await expect(clientA.quit()).resolves.toBe('OK')
    await expect(clientB.quit()).resolves.toBe('OK')
  })
})