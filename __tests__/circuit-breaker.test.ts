jest.mock('date-fns', () => ({
  ...jest.requireActual('date-fns'),
  const actual = (() => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return jest.requireActual('date-fns')
    } catch {
      return {}
    }
  })()
  return {
    ...actual,
    format: jest.fn(() => '2024-01-01'),
    subMonths: jest.fn(() => new Date('2024-01-01')),
  }
})

jest.mock('react-use', () => ({
  ...jest.requireActual('react-use'),
  const actual = (() => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return jest.requireActual('react-use')
    } catch {
      return {}
    }
  })()
  return {
    ...actual,
    useMedia: jest.fn(() => false),
  }
})

jest.mock('@/config/redis', () => ({
  ...jest.requireActual('@/config/redis'),
  const actual = (() => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return jest.requireActual('@/config/redis')
    } catch {
      return {}
    }
  })()
  const store: Record<string, string> = {}
  const client = {
    get: jest.fn(async (key: string) => (key in store ? store[key] : null)),
    set: jest.fn(async (key: string, value: string) => {
      store[key] = value
      return 'OK'
    }),
    del: jest.fn(async (key: string) => {
      const existed = key in store ? 1 : 0
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

import { format, subMonths } from 'date-fns'
import { useMedia } from 'react-use'
import { getRedisClient } from '@/config/redis'
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals'

describe('external dependency mocks behave deterministically', () => {
  it('date-fns: format returns a fixed string', () => {
    const result = format(new Date('1999-12-31'), 'yyyy-MM-dd')
    expect(result).toBe('2024-01-01')
    expect((format as unknown as jest.Mock).mock.calls.length).toBeGreaterThan(0)
  })

  it('date-fns: subMonths returns a fixed date', () => {
    const result = subMonths(new Date('2024-02-15'), 1)
    expect(result).toEqual(new Date('2024-01-01'))
    expect((subMonths as unknown as jest.Mock).mock.calls.length).toBeGreaterThan(0)
  })

  it('react-use: useMedia returns false', () => {
    const val = (useMedia as unknown as () => boolean)()
    expect(val).toBe(false)
    expect((useMedia as unknown as jest.Mock).mock.calls.length).toBeGreaterThan(0)
  })
})

describe('redis client behavior (mocked)', () => {
  it('set/get/del/quit roundtrip works as expected', async () => {
    const client: any = await getRedisClient()
    const key = `cb:test:${Math.random().toString(36).slice(2)}`
    const value = 'some-value'

    // initial get -> null
    await expect(client.get(key)).resolves.toBeNull()

    // set -> OK
    await expect(client.set(key, value)).resolves.toBe('OK')

    // get -> value
    await expect(client.get(key)).resolves.toBe(value)

    // del existing -> 1
    await expect(client.del(key)).resolves.toBe(1)

    // get after delete -> null
    await expect(client.get(key)).resolves.toBeNull()

    // del again (missing) -> 0
    await expect(client.del(key)).resolves.toBe(0)

    // quit -> OK
    await expect(client.quit()).resolves.toBe('OK')

    expect(client.set).toHaveBeenCalled()
    expect(client.get).toHaveBeenCalled()
    expect(client.del).toHaveBeenCalled()
    expect(client.quit).toHaveBeenCalled()
  })
})