jest.mock('date-fns', () => ({
  ...jest.requireActual('date-fns'),
  const actual = jest.requireActual('date-fns')
  return {
    ...actual,
    format: jest.fn(() => '2024-01-01'),
    subMonths: jest.fn(() => new Date('2024-01-01')),
  }
})

jest.mock('react-use', () => ({
  ...jest.requireActual('react-use'),
  const actual = jest.requireActual('react-use')
  return {
    ...actual,
    useMedia: jest.fn(() => false),
  }
})

jest.mock('@/config/redis', () => ({
  ...jest.requireActual('@/config/redis'),
  const actual = jest.requireActual('@/config/redis')
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

afterEach(() => {
  jest.clearAllMocks()
})

describe('external dependency mocks behave deterministically', () => {
  it('date-fns: format returns a fixed string', () => {
    const result = format(new Date('1999-12-31'), 'yyyy-MM-dd')
    expect(result).toBe('2024-01-01')
    expect((format as any).mock.calls.length).toBeGreaterThan(0)
  })

  it('date-fns: subMonths returns a fixed date', () => {
    const result = subMonths(new Date('2024-02-15'), 1)
    expect(result).toEqual(new Date('2024-01-01'))
    expect((subMonths as any).mock.calls.length).toBeGreaterThan(0)
  })

  it('react-use: useMedia returns false', () => {
    const val = (useMedia as unknown as () => boolean)()
    expect(val).toBe(false)
    expect((useMedia as any).mock.calls.length).toBeGreaterThan(0)
  })
})

describe('redis client behavior (mocked)', () => {
  it('set/get/del/quit roundtrip works as expected', async () => {
    const client: any = await getRedisClient()
    const key = `cb:test:${Math.random().toString(36).slice(2)}`
    const value = 'some-value'

    await expect(client.get(key)).resolves.toBeNull()
    await expect(client.set(key, value)).resolves.toBe('OK')
    await expect(client.get(key)).resolves.toBe(value)
    await expect(client.del(key)).resolves.toBe(1)
    await expect(client.get(key)).resolves.toBeNull()
    await expect(client.quit()).resolves.toBe('OK')
  })
})