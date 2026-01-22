import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals'
import request from 'supertest'

jest.mock('axios', () => ({
  ...jest.requireActual('axios'),
  get: jest.fn()
}))

// Import the app by requiring the module so that the server starts as in real usage
// We need to get the Express app instance from the module; since the source file
// does not export it, we will require it for side effects and then access the
// default export if present, or fall back to the created app via require cache.
let app: any
let axios: any

describe('js-service index.ts', () => {
  beforeEach(() => {
    jest.resetModules()
    jest.clearAllMocks()

    // Re-require axios mock after resetModules
    axios = require('axios')
    // Re-require the service file fresh each time
    const mod = require('../src/index')
    // If the module exports the app, use it; otherwise, try common patterns
    app = mod.default || mod.app || mod
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  it('GET /health returns healthy status and service name', async () => {
    const res = await request(app).get('/health')

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      status: 'healthy',
      service: 'js-cache'
    })
  })

  it('GET /cache/stats returns empty stats when no services cached', async () => {
    const res = await request(app).get('/cache/stats')

    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('timestamp')
    expect(typeof res.body.timestamp).toBe('string')
    expect(res.body).toHaveProperty('cacheStats')
    expect(Array.isArray(res.body.cacheStats)).toBe(true)
    expect(res.body.cacheStats.length).toBe(0)
    expect(res.body.totalServices).toBe(0)
  })

  it('POST /cache/record initializes cache entry for new service and records miss with key', async () => {
    const service = 'go'
    const key = 'user:1'

    const res = await request(app)
      .post('/cache/record')
      .send({ service, key, hit: false })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ success: true })

    const statsRes = await request(app).get('/cache/stats')
    expect(statsRes.status).toBe(200)
    expect(statsRes.body.totalServices).toBe(1)
    expect(statsRes.body.cacheStats[0]).toMatchObject({
      service,
      hits: 0,
      misses: 1,
      size: 1,
      hitRate: '0.00%'
    })
  })

  it('POST /cache/record increments hits when hit=true and does not add entry', async () => {
    const service = 'python'
    const key = 'item:42'

    const missRes = await request(app)
      .post('/cache/record')
      .send({ service, key, hit: false })
    expect(missRes.status).toBe(200)

    const hitRes = await request(app)
      .post('/cache/record')
      .send({ service, key, hit: true })
    expect(hitRes.status).toBe(200)

    const statsRes = await request(app).get('/cache/stats')
    expect(statsRes.status).toBe(200)
    const stat = statsRes.body.cacheStats.find((s: any) => s.service === service)
    expect(stat).toBeDefined()
    expect(stat.hits).toBe(1)
    expect(stat.misses).toBe(1)
    expect(stat.size).toBe(1)
    const total = stat.hits + stat.misses
    const expectedHitRate = ((stat.hits / total) * 100).toFixed(2) + '%'
    expect(stat.hitRate).toBe(expectedHitRate)
  })

  it('POST /cache/record returns 400 when service is missing', async () => {
    const res = await request(app)
      .post('/cache/record')
      .send({ key: 'x', hit: true })

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'Service name required' })
  })

  it('POST /cache/invalidate returns 400 when service is missing', async () => {
    const res = await request(app)
      .post('/cache/invalidate')
      .send({ key: 'x' })

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'Service name required' })
  })

  it('POST /cache/invalidate returns 404 when cache for service not found', async () => {
    const res = await request(app)
      .post('/cache/invalidate')
      .send({ service: 'unknown', key: 'x' })

    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: "Cache for service 'unknown' not found" })
  })

  it('POST /cache/invalidate with key deletes only that key and returns remainingEntries', async () => {
    const service = 'ruby'
    await request(app).post('/cache/record').send({ service, key: 'a', hit: false })
    await request(app).post('/cache/record').send({ service, key: 'b', hit: false })

    const invalidateRes = await request(app)
      .post('/cache/invalidate')
      .send({ service, key: 'a' })

    expect(invalidateRes.status).toBe(200)
    expect(invalidateRes.body).toEqual({
      message: "Cache key 'a' invalidated for service 'ruby'",
      remainingEntries: 1
    })

    const statsRes = await request(app).get('/cache/stats')
    const stat = statsRes.body.cacheStats.find((s: any) => s.service === service)
    expect(stat.size).toBe(1)
  })

  it('POST /cache/invalidate without key clears all entries and resets hits/misses', async () => {
    const service = 'go'
    await request(app).post('/cache/record').send({ service, key: 'k1', hit: false })
    await request(app).post('/cache/record').send({ service, key: 'k2', hit: false })
    await request(app).post('/cache/record').send({ service, key: 'k1', hit: true })

    const invalidateRes = await request(app)
      .post('/cache/invalidate')
      .send({ service })

    expect(invalidateRes.status).toBe(200)
    expect(invalidateRes.body).toEqual({
      message: "All cache cleared for service 'go'"
    })

    const statsRes = await request(app).get('/cache/stats')
    const stat = statsRes.body.cacheStats.find((s: any) => s.service === service)
    expect(stat.size).toBe(0)
    expect(stat.hits).toBe(0)
    expect(stat.misses).toBe(0)
    expect(stat.hitRate).toBe('0.00%')
  })

  it('POST /cache/invalidate-all clears all caches across all services', async () => {
    await request(app).post('/cache/record').send({ service: 'go', key: '1', hit: false })
    await request(app).post('/cache/record').send({ service: 'python', key: '2', hit: false })

    const beforeRes = await request(app).get('/cache/stats')
    expect(beforeRes.body.totalServices).toBe(2)

    const invalidateAllRes = await request(app).post('/cache/invalidate-all').send()
    expect(invalidateAllRes.status).toBe(200)
    expect(invalidateAllRes.body).toHaveProperty('message', 'All caches cleared across all services')
    expect(typeof invalidateAllRes.body.timestamp).toBe('string')

    const afterRes = await request(app).get('/cache/stats')
    expect(afterRes.body.totalServices).toBe(0)
    expect(afterRes.body.cacheStats).toEqual([])
  })

  it('GET /cache/services returns three services with offline status when axios.get rejects', async () => {
    ;(axios.get as jest.Mock).mockRejectedValue(new Error('Network error'))

    const res = await request(app).get('/cache/services')

    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('services')
    expect(res.body.services).toHaveLength(3)
    expect(res.body).toHaveProperty('timestamp')
    const names = res.body.services.map((s: any) => s.name)
    expect(names.sort()).toEqual(['go', 'python', 'ruby'])
    res.body.services.forEach((svc: any) => {
      expect(svc.status).toBe('offline')
      expect(svc.cacheEnabled).toBe(false)
    })
  })

  it('GET /cache/services marks services online when axios.get returns 200', async () => {
    ;(axios.get as jest.Mock).mockResolvedValue({ status: 200 })

    const res = await request(app).get('/cache/services')

    expect(res.status).toBe(200)
    expect(res.body.services).toHaveLength(3)
    res.body.services.forEach((svc: any) => {
      expect(svc.status).toBe('online')
      expect([8080, 8081, 8082]).toContain(svc.port)
      expect(svc.cacheEnabled).toBe(false)
    })
  })

  it('GET /cache/services sets cacheEnabled true when cache exists for service', async () => {
    await request(app).post('/cache/record').send({ service: 'go', key: '1', hit: false })
    await request(app).post('/cache/record').send({ service: 'python', key: '2', hit: true })

    ;(axios.get as jest.Mock).mockResolvedValue({ status: 200 })

    const res = await request(app).get('/cache/services')

    expect(res.status).toBe(200)
    const goService = res.body.services.find((s: any) => s.name === 'go')
    const pythonService = res.body.services.find((s: any) => s.name === 'python')
    const rubyService = res.body.services.find((s: any) => s.name === 'ruby')

    expect(goService.cacheEnabled).toBe(true)
    expect(pythonService.cacheEnabled).toBe(true)
    expect(rubyService.cacheEnabled).toBe(false)
  })

  it('GET /cache/services treats non-200 responses as offline', async () => {
    ;(axios.get as jest.Mock).mockResolvedValue({ status: 500 })

    const res = await request(app).get('/cache/services')

    expect(res.status).toBe(200)
    res.body.services.forEach((svc: any) => {
      expect(svc.status).toBe('offline')
    })
  })

  it('GET /cache/stats computes hitRate correctly for multiple services', async () => {
    await request(app).post('/cache/record').send({ service: 'go', key: '1', hit: true })
    await request(app).post('/cache/record').send({ service: 'go', key: '2', hit: false })
    await request(app).post('/cache/record').send({ service: 'go', key: '3', hit: false })

    await request(app).post('/cache/record').send({ service: 'python', key: 'a', hit: false })
    await request(app).post('/cache/record').send({ service: 'python', key: 'a', hit: true })
    await request(app).post('/cache/record').send({ service: 'python', key: 'b', hit: true })

    const res = await request(app).get('/cache/stats')
    expect(res.status).toBe(200)
    const goStat = res.body.cacheStats.find((s: any) => s.service === 'go')
    const pyStat = res.body.cacheStats.find((s: any) => s.service === 'python')

    const goTotal = goStat.hits + goStat.misses
    const goExpectedHitRate = ((goStat.hits / goTotal) * 100).toFixed(2) + '%'
    expect(goStat.hitRate).toBe(goExpectedHitRate)

    const pyTotal = pyStat.hits + pyStat.misses
    const pyExpectedHitRate = ((pyStat.hits / pyTotal) * 100).toFixed(2) + '%'
    expect(pyStat.hitRate).toBe(pyExpectedHitRate)
  })

  it('POST /cache/record does not add entry when miss has no key', async () => {
    const service = 'nokey'
    await request(app).post('/cache/record').send({ service, hit: false })

    const res = await request(app).get('/cache/stats')
    const stat = res.body.cacheStats.find((s: any) => s.service === service)
    expect(stat.misses).toBe(1)
    expect(stat.size).toBe(0)
  })

  it('POST /cache/record can be called multiple times for same key without duplicating size', async () => {
    const service = 'dup'
    const key = 'same'

    await request(app).post('/cache/record').send({ service, key, hit: false })
    await request(app).post('/cache/record').send({ service, key, hit: false })

    const res = await request(app).get('/cache/stats')
    const stat = res.body.cacheStats.find((s: any) => s.service === service)
    expect(stat.misses).toBe(2)
    expect(stat.size).toBe(1)
  })
})