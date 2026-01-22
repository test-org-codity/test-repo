import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals'
import request from 'supertest'
import axios from 'axios'

jest.mock('axios', () => ({
  ...jest.requireActual('axios'),
  get: jest.fn()
}))

// Mock express app module to capture the app instance
let app: any

jest.isolateModules(() => {
  // Importing the module will start the server due to app.listen
  // but we only need the app instance for testing via supertest.
  const express = require('express')
  const originalExpress = jest.requireActual('express')

  // Spy on express() to capture the app instance
  const expressMock = () => {
    app = originalExpress()
    return app
  }

  Object.assign(expressMock, originalExpress)

  jest.doMock('express', () => expressMock)

  require('../src/index')
})

const mockedAxiosGet = axios.get as jest.Mock

describe('js-service index routes', () => {
  beforeEach(() => {
    mockedAxiosGet.mockReset()
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
    expect(res.body.cacheStats).toEqual([])
    expect(res.body.totalServices).toBe(0)
  })

  it('POST /cache/record initializes cache entry for new service and records miss with key', async () => {
    const res = await request(app)
      .post('/cache/record')
      .send({ service: 'go', key: 'user:1', hit: false })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ success: true })

    const statsRes = await request(app).get('/cache/stats')
    expect(statsRes.status).toBe(200)
    expect(statsRes.body.totalServices).toBe(1)
    expect(statsRes.body.cacheStats[0]).toMatchObject({
      service: 'go',
      hits: 0,
      misses: 1,
      size: 1,
      hitRate: '0.00%'
    })
  })

  it('POST /cache/record increments hits and does not add entry when hit is true', async () => {
    await request(app)
      .post('/cache/record')
      .send({ service: 'python', key: 'item:1', hit: false })

    const resHit = await request(app)
      .post('/cache/record')
      .send({ service: 'python', key: 'item:1', hit: true })

    expect(resHit.status).toBe(200)
    expect(resHit.body).toEqual({ success: true })

    const statsRes = await request(app).get('/cache/stats')
    const pythonStats = statsRes.body.cacheStats.find((s: any) => s.service === 'python')
    expect(pythonStats).toBeDefined()
    expect(pythonStats.hits).toBe(1)
    expect(pythonStats.misses).toBe(1)
    expect(pythonStats.size).toBe(1)
    const total = pythonStats.hits + pythonStats.misses
    const expectedHitRate = ((pythonStats.hits / total) * 100).toFixed(2) + '%'
    expect(pythonStats.hitRate).toBe(expectedHitRate)
  })

  it('POST /cache/record without key on miss does not add entry', async () => {
    await request(app)
      .post('/cache/record')
      .send({ service: 'ruby', hit: false })

    const statsRes = await request(app).get('/cache/stats')
    const rubyStats = statsRes.body.cacheStats.find((s: any) => s.service === 'ruby')
    expect(rubyStats).toBeDefined()
    expect(rubyStats.misses).toBe(1)
    expect(rubyStats.size).toBe(0)
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
      .send({ service: 'nonexistent', key: 'x' })

    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: "Cache for service 'nonexistent' not found" })
  })

  it('POST /cache/invalidate with key deletes only that key and returns remainingEntries', async () => {
    await request(app)
      .post('/cache/record')
      .send({ service: 'go', key: 'k1', hit: false })
    await request(app)
      .post('/cache/record')
      .send({ service: 'go', key: 'k2', hit: false })

    const res = await request(app)
      .post('/cache/invalidate')
      .send({ service: 'go', key: 'k1' })

    expect(res.status).toBe(200)
    expect(res.body.message).toBe("Cache key 'k1' invalidated for service 'go'")
    expect(res.body.remainingEntries).toBe(1)

    const statsRes = await request(app).get('/cache/stats')
    const goStats = statsRes.body.cacheStats.find((s: any) => s.service === 'go')
    expect(goStats.size).toBe(1)
  })

  it('POST /cache/invalidate without key clears all entries and resets hits/misses', async () => {
    await request(app)
      .post('/cache/record')
      .send({ service: 'python', key: 'a', hit: false })
    await request(app)
      .post('/cache/record')
      .send({ service: 'python', key: 'b', hit: true })

    const res = await request(app)
      .post('/cache/invalidate')
      .send({ service: 'python' })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      message: "All cache cleared for service 'python'"
    })

    const statsRes = await request(app).get('/cache/stats')
    const pythonStats = statsRes.body.cacheStats.find((s: any) => s.service === 'python')
    expect(pythonStats.size).toBe(0)
    expect(pythonStats.hits).toBe(0)
    expect(pythonStats.misses).toBe(0)
  })

  it('POST /cache/invalidate-all clears all caches and returns timestamp', async () => {
    await request(app)
      .post('/cache/record')
      .send({ service: 'go', key: 'k1', hit: false })
    await request(app)
      .post('/cache/record')
      .send({ service: 'python', key: 'k2', hit: false })

    const res = await request(app).post('/cache/invalidate-all')

    expect(res.status).toBe(200)
    expect(res.body.message).toBe('All caches cleared across all services')
    expect(typeof res.body.timestamp).toBe('string')

    const statsRes = await request(app).get('/cache/stats')
    expect(statsRes.body.totalServices).toBe(0)
    expect(statsRes.body.cacheStats).toEqual([])
  })

  it('GET /cache/services returns all services with online status when axios succeeds', async () => {
    mockedAxiosGet.mockResolvedValue({ status: 200 })

    const res = await request(app).get('/cache/services')

    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('timestamp')
    expect(Array.isArray(res.body.services)).toBe(true)
    expect(res.body.services.length).toBe(3)

    const names = res.body.services.map((s: any) => s.name).sort()
    expect(names).toEqual(['go', 'python', 'ruby'])

    res.body.services.forEach((service: any) => {
      expect(service.status).toBe('online')
      expect(service).toHaveProperty('port')
      expect(service).toHaveProperty('cacheEnabled')
    })

    expect(mockedAxiosGet).toHaveBeenCalledTimes(3)
    expect(mockedAxiosGet).toHaveBeenCalledWith('http://localhost:8080/health', { timeout: 2000 })
    expect(mockedAxiosGet).toHaveBeenCalledWith('http://localhost:8081/health', { timeout: 2000 })
    expect(mockedAxiosGet).toHaveBeenCalledWith('http://localhost:8082/health', { timeout: 2000 })
  })

  it('GET /cache/services marks service offline when axios throws error', async () => {
    mockedAxiosGet.mockRejectedValueOnce(new Error('Network error'))
    mockedAxiosGet.mockResolvedValueOnce({ status: 200 })
    mockedAxiosGet.mockRejectedValueOnce(new Error('Network error'))

    const res = await request(app).get('/cache/services')

    expect(res.status).toBe(200)
    const services = res.body.services

    const go = services.find((s: any) => s.name === 'go')
    const python = services.find((s: any) => s.name === 'python')
    const ruby = services.find((s: any) => s.name === 'ruby')

    expect(go.status).toBe('offline')
    expect(python.status).toBe('online')
    expect(ruby.status).toBe('offline')
  })

  it('GET /cache/services reflects cacheEnabled based on existing cache entries', async () => {
    mockedAxiosGet.mockResolvedValue({ status: 200 })

    await request(app)
      .post('/cache/record')
      .send({ service: 'go', key: 'k1', hit: false })

    const res = await request(app).get('/cache/services')

    const go = res.body.services.find((s: any) => s.name === 'go')
    const python = res.body.services.find((s: any) => s.name === 'python')
    const ruby = res.body.services.find((s: any) => s.name === 'ruby')

    expect(go.cacheEnabled).toBe(true)
    expect(python.cacheEnabled).toBe(false)
    expect(ruby.cacheEnabled).toBe(false)
  })

  it('GET /cache/stats calculates hitRate as 0.00% when no hits or misses', async () => {
    await request(app)
      .post('/cache/record')
      .send({ service: 'empty-service', hit: true })
    await request(app)
      .post('/cache/invalidate')
      .send({ service: 'empty-service' })

    const res = await request(app).get('/cache/stats')
    const emptyStats = res.body.cacheStats.find((s: any) => s.service === 'empty-service')
    expect(emptyStats).toBeDefined()
    expect(emptyStats.hits).toBe(0)
    expect(emptyStats.misses).toBe(0)
    expect(emptyStats.hitRate).toBe('0.00%')
  })

  it('GET /cache/stats calculates correct hitRate percentage', async () => {
    await request(app)
      .post('/cache/record')
      .send({ service: 'stats-service', hit: true })
    await request(app)
      .post('/cache/record')
      .send({ service: 'stats-service', hit: true })
    await request(app)
      .post('/cache/record')
      .send({ service: 'stats-service', hit: false, key: 'k1' })

    const res = await request(app).get('/cache/stats')
    const stats = res.body.cacheStats.find((s: any) => s.service === 'stats-service')
    expect(stats.hits).toBe(2)
    expect(stats.misses).toBe(1)
    expect(stats.size).toBe(1)
    expect(stats.hitRate).toBe('66.67%')
  })

  it('POST /cache/record can be called multiple times for same service without errors', async () => {
    const payloads = [
      { service: 'multi', hit: true },
      { service: 'multi', hit: false, key: 'a' },
      { service: 'multi', hit: false, key: 'b' },
      { service: 'multi', hit: true }
    ]

    for (const p of payloads) {
      const res = await request(app).post('/cache/record').send(p)
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ success: true })
    }

    const statsRes = await request(app).get('/cache/stats')
    const multiStats = statsRes.body.cacheStats.find((s: any) => s.service === 'multi')
    expect(multiStats.hits).toBe(2)
    expect(multiStats.misses).toBe(2)
    expect(multiStats.size).toBe(2)
  })

  it('POST /cache/invalidate for service with single key leaves size 0 and does not error when called again', async () => {
    await request(app)
      .post('/cache/record')
      .send({ service: 'single', key: 'only', hit: false })

    const first = await request(app)
      .post('/cache/invalidate')
      .send({ service: 'single', key: 'only' })

    expect(first.status).toBe(200)
    expect(first.body.remainingEntries).toBe(0)

    const second = await request(app)
      .post('/cache/invalidate')
      .send({ service: 'single', key: 'only' })

    expect(second.status).toBe(200)
    expect(second.body.remainingEntries).toBe(0)
  })
})