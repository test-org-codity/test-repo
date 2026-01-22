import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals'
import request from 'supertest'

jest.mock('axios', () => ({
  ...jest.requireActual('axios'),
  get: jest.fn()
}))

// We import the app module so that the Express app and routes are registered.
// The server will start listening immediately as written in the source.
import '../src/index'
import axios from 'axios'

const mockedAxiosGet = axios.get as jest.Mock

// Access the running server via its default port (8083) using supertest's ability
// to work against a URL when given a string instead of an Express app instance.
const baseUrl = 'http://localhost:8083'

describe('js-cache service API', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  describe('GET /health', () => {
    it('returns healthy status and service name', async () => {
      const res = await request(baseUrl).get('/health')

      expect(res.status).toBe(200)
      expect(res.body).toEqual({
        status: 'healthy',
        service: 'js-cache'
      })
    })
  })

  describe('POST /cache/record', () => {
    it('returns 400 when service is missing', async () => {
      const res = await request(baseUrl)
        .post('/cache/record')
        .send({ key: 'k1', hit: true })

      expect(res.status).toBe(400)
      expect(res.body).toEqual({ error: 'Service name required' })
    })

    it('creates cache entry for new service and records a miss with key', async () => {
      const service = 'service-miss-create'
      const res = await request(baseUrl)
        .post('/cache/record')
        .send({ service, key: 'key1', hit: false })

      expect(res.status).toBe(200)
      expect(res.body).toEqual({ success: true })

      const statsRes = await request(baseUrl).get('/cache/stats')
      expect(statsRes.status).toBe(200)
      const svcStats = statsRes.body.cacheStats.find((s: any) => s.service === service)
      expect(svcStats).toBeDefined()
      expect(svcStats.hits).toBe(0)
      expect(svcStats.misses).toBe(1)
      expect(svcStats.size).toBe(1)
      expect(svcStats.hitRate).toBe('0.00%')
    })

    it('increments hits without adding cache entries when hit=true', async () => {
      const service = 'service-hit-only'
      const res1 = await request(baseUrl)
        .post('/cache/record')
        .send({ service, hit: true })

      expect(res1.status).toBe(200)

      const res2 = await request(baseUrl)
        .post('/cache/record')
        .send({ service, hit: true })

      expect(res2.status).toBe(200)

      const statsRes = await request(baseUrl).get('/cache/stats')
      const svcStats = statsRes.body.cacheStats.find((s: any) => s.service === service)
      expect(svcStats).toBeDefined()
      expect(svcStats.hits).toBe(2)
      expect(svcStats.misses).toBe(0)
      expect(svcStats.size).toBe(0)
      expect(svcStats.hitRate).toBe('100.00%')
    })

    it('increments misses and stores entries only when key is provided and hit=false', async () => {
      const service = 'service-miss-entries'

      const res1 = await request(baseUrl)
        .post('/cache/record')
        .send({ service, hit: false, key: 'k1' })
      expect(res1.status).toBe(200)

      const res2 = await request(baseUrl)
        .post('/cache/record')
        .send({ service, hit: false })
      expect(res2.status).toBe(200)

      const res3 = await request(baseUrl)
        .post('/cache/record')
        .send({ service, hit: false, key: 'k2' })
      expect(res3.status).toBe(200)

      const statsRes = await request(baseUrl).get('/cache/stats')
      const svcStats = statsRes.body.cacheStats.find((s: any) => s.service === service)
      expect(svcStats).toBeDefined()
      expect(svcStats.hits).toBe(0)
      expect(svcStats.misses).toBe(3)
      expect(svcStats.size).toBe(2)
      expect(svcStats.hitRate).toBe('0.00%')
    })
  })

  describe('GET /cache/stats', () => {
    it('returns empty stats when no services are recorded', async () => {
      await request(baseUrl).post('/cache/invalidate-all')

      const res = await request(baseUrl).get('/cache/stats')

      expect(res.status).toBe(200)
      expect(Array.isArray(res.body.cacheStats)).toBe(true)
      expect(res.body.cacheStats.length).toBe(0)
      expect(res.body.totalServices).toBe(0)
      expect(typeof res.body.timestamp).toBe('string')
    })

    it('computes hit rate correctly for mixed hits and misses', async () => {
      const service = 'service-hit-rate'
      await request(baseUrl).post('/cache/invalidate-all')

      await request(baseUrl)
        .post('/cache/record')
        .send({ service, hit: true })
      await request(baseUrl)
        .post('/cache/record')
        .send({ service, hit: true })
      await request(baseUrl)
        .post('/cache/record')
        .send({ service, hit: false, key: 'm1' })

      const res = await request(baseUrl).get('/cache/stats')
      const svcStats = res.body.cacheStats.find((s: any) => s.service === service)

      expect(svcStats).toBeDefined()
      expect(svcStats.hits).toBe(2)
      expect(svcStats.misses).toBe(1)
      expect(svcStats.size).toBe(1)
      expect(svcStats.hitRate).toBe('66.67%')
    })
  })

  describe('POST /cache/invalidate', () => {
    it('returns 400 when service is missing', async () => {
      const res = await request(baseUrl)
        .post('/cache/invalidate')
        .send({ key: 'some-key' })

      expect(res.status).toBe(400)
      expect(res.body).toEqual({ error: 'Service name required' })
    })

    it('returns 404 when service cache does not exist', async () => {
      const res = await request(baseUrl)
        .post('/cache/invalidate')
        .send({ service: 'non-existent', key: 'k1' })

      expect(res.status).toBe(404)
      expect(res.body).toEqual({ error: "Cache for service 'non-existent' not found" })
    })

    it('invalidates specific key and returns remainingEntries', async () => {
      const service = 'service-invalidate-key'
      await request(baseUrl)
        .post('/cache/record')
        .send({ service, hit: false, key: 'k1' })
      await request(baseUrl)
        .post('/cache/record')
        .send({ service, hit: false, key: 'k2' })

      const res = await request(baseUrl)
        .post('/cache/invalidate')
        .send({ service, key: 'k1' })

      expect(res.status).toBe(200)
      expect(res.body.message).toBe("Cache key 'k1' invalidated for service 'service-invalidate-key'")
      expect(res.body.remainingEntries).toBe(1)

      const statsRes = await request(baseUrl).get('/cache/stats')
      const svcStats = statsRes.body.cacheStats.find((s: any) => s.service === service)
      expect(svcStats.size).toBe(1)
    })

    it('clears all entries and resets hits/misses when key is not provided', async () => {
      const service = 'service-invalidate-all-for-one'
      await request(baseUrl)
        .post('/cache/record')
        .send({ service, hit: true })
      await request(baseUrl)
        .post('/cache/record')
        .send({ service, hit: false, key: 'k1' })

      const res = await request(baseUrl)
        .post('/cache/invalidate')
        .send({ service })

      expect(res.status).toBe(200)
      expect(res.body).toEqual({
        message: "All cache cleared for service 'service-invalidate-all-for-one'"
      })

      const statsRes = await request(baseUrl).get('/cache/stats')
      const svcStats = statsRes.body.cacheStats.find((s: any) => s.service === service)
      expect(svcStats.hits).toBe(0)
      expect(svcStats.misses).toBe(0)
      expect(svcStats.size).toBe(0)
      expect(svcStats.hitRate).toBe('0.00%')
    })
  })

  describe('POST /cache/invalidate-all', () => {
    it('clears all services from cache and returns confirmation', async () => {
      await request(baseUrl)
        .post('/cache/record')
        .send({ service: 'svc1', hit: false, key: 'k1' })
      await request(baseUrl)
        .post('/cache/record')
        .send({ service: 'svc2', hit: true })

      const res = await request(baseUrl).post('/cache/invalidate-all')
      expect(res.status).toBe(200)
      expect(res.body.message).toBe('All caches cleared across all services')
      expect(typeof res.body.timestamp).toBe('string')

      const statsRes = await request(baseUrl).get('/cache/stats')
      expect(statsRes.body.cacheStats.length).toBe(0)
      expect(statsRes.body.totalServices).toBe(0)
    })
  })

  describe('GET /cache/services', () => {
    it('returns three services with status derived from axios results (online/offline)', async () => {
      mockedAxiosGet
        .mockResolvedValueOnce({ status: 200 })
        .mockResolvedValueOnce({ status: 500 })
        .mockRejectedValueOnce(new Error('Network error'))

      const res = await request(baseUrl).get('/cache/services')

      expect(res.status).toBe(200)
      const services = res.body.services
      expect(services).toHaveLength(3)

      const go = services.find((s: any) => s.name === 'go')
      const python = services.find((s: any) => s.name === 'python')
      const ruby = services.find((s: any) => s.name === 'ruby')

      expect(go.status).toBe('online')
      expect(python.status).toBe('offline')
      expect(ruby.status).toBe('offline')

      expect(go.port).toBe(8080)
      expect(python.port).toBe(8081)
      expect(ruby.port).toBe(8082)

      expect(typeof res.body.timestamp).toBe('string')
    })

    it('sets cacheEnabled based on existing service cache entries', async () => {
      await request(baseUrl)
        .post('/cache/record')
        .send({ service: 'go', hit: true })
      await request(baseUrl)
        .post('/cache/record')
        .send({ service: 'ruby', hit: false, key: 'rk1' })

      mockedAxiosGet
        .mockRejectedValueOnce(new Error('go offline'))
        .mockRejectedValueOnce(new Error('python offline'))
        .mockRejectedValueOnce(new Error('ruby offline'))

      const res = await request(baseUrl).get('/cache/services')
      expect(res.status).toBe(200)

      const services = res.body.services

      const go = services.find((s: any) => s.name === 'go')
      const python = services.find((s: any) => s.name === 'python')
      const ruby = services.find((s: any) => s.name === 'ruby')

      expect(go.cacheEnabled).toBe(true)
      expect(python.cacheEnabled).toBe(false)
      expect(ruby.cacheEnabled).toBe(true)
    })

    it('uses provided service URLs from environment when set', async () => {
      const originalGo = process.env.GO_SERVICE_URL
      const originalPy = process.env.PYTHON_SERVICE_URL
      const originalRb = process.env.RUBY_SERVICE_URL

      process.env.GO_SERVICE_URL = 'http://go-custom:9000'
      process.env.PYTHON_SERVICE_URL = 'http://py-custom:9001'
      process.env.RUBY_SERVICE_URL = 'http://rb-custom:9002'

      jest.resetModules()
      jest.mock('axios', () => ({
        ...jest.requireActual('axios'),
        get: jest.fn()
      }))
      const axiosReloaded = (await import('axios')).default as any
      const mockedReloadedGet = axiosReloaded.get as jest.Mock
      mockedReloadedGet
        .mockResolvedValueOnce({ status: 200 })
        .mockResolvedValueOnce({ status: 200 })
        .mockResolvedValueOnce({ status: 200 })

      await import('../src/index')

      const res = await request('http://localhost:8083').get('/cache/services')

      expect(res.status).toBe(200)
      expect(mockedReloadedGet).toHaveBeenNthCalledWith(
        1,
        'http://go-custom:9000/health',
        expect.objectContaining({ timeout: 2000 })
      )
      expect(mockedReloadedGet).toHaveBeenNthCalledWith(
        2,
        'http://py-custom:9001/health',
        expect.objectContaining({ timeout: 2000 })
      )
      expect(mockedReloadedGet).toHaveBeenNthCalledWith(
        3,
        'http://rb-custom:9002/health',
        expect.objectContaining({ timeout: 2000 })
      )

      process.env.GO_SERVICE_URL = originalGo
      process.env.PYTHON_SERVICE_URL = originalPy
      process.env.RUBY_SERVICE_URL = originalRb
    })
  })
})