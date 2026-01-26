import { describe, it, expect, jest, afterEach } from '@jest/globals'
import {
  preset,
  testEnvironment,
  roots,
  testMatch,
  moduleFileExtensions,
  collectCoverageFrom,
  coverageDirectory,
  coverageReporters,
  transform
} from '../jest.config'

const config = jest.requireActual('../jest.config')

afterEach(() => {
  jest.clearAllMocks()
})

describe('jest.config.js exports', () => {
  it('exports a config object', () => {
    expect(typeof config).toBe('object')
    expect(config).not.toBeNull()
  })

  it('has the exact set of top-level keys', () => {
    const keys = Object.keys(config).sort()
    const expected = [
      'preset',
      'testEnvironment',
      'roots',
      'testMatch',
      'moduleFileExtensions',
      'collectCoverageFrom',
      'coverageDirectory',
      'coverageReporters',
      'transform'
    ].sort()
    expect(keys).toEqual(expected)
  })

  it('preset is ts-jest', () => {
    expect(preset).toBe('ts-jest')
    expect(config.preset).toBe('ts-jest')
  })

  it('testEnvironment is node', () => {
    expect(testEnvironment).toBe('node')
    expect(config.testEnvironment).toBe('node')
  })

  it('roots contains src and __tests__ in the correct order', () => {
    expect(Array.isArray(roots)).toBe(true)
    expect(roots).toEqual(['<rootDir>/src', '<rootDir>/__tests__'])
  })

  it('testMatch targets only .ts test files', () => {
    expect(testMatch).toEqual(['**/__tests__/**/*.test.ts', '**/?(*.)+(spec|test).ts'])
    expect(testMatch.every(p => p.endsWith('.ts'))).toBe(true)
  })

  it('moduleFileExtensions includes TS, TSX, JS, JSX, JSON, node', () => {
    expect(moduleFileExtensions).toEqual(['ts', 'tsx', 'js', 'jsx', 'json', 'node'])
    expect(moduleFileExtensions).toContain('node')
    expect(moduleFileExtensions).toContain('json')
  })

  it('collectCoverageFrom patterns include src and exclude d.ts and test.ts', () => {
    expect(collectCoverageFrom).toEqual([
      'src/**/*.{ts,tsx}',
      '!src/**/*.d.ts',
      '!src/**/*.test.ts'
    ])
    expect(collectCoverageFrom[1].startsWith('!')).toBe(true)
    expect(collectCoverageFrom[2].startsWith('!')).toBe(true)
  })

  it('coverageDirectory is coverage', () => {
    expect(coverageDirectory).toBe('coverage')
  })

  it('coverageReporters include text, json, html exactly', () => {
    expect(coverageReporters).toEqual(['text', 'json', 'html'])
    expect(coverageReporters).toContain('html')
  })

  it('transform contains a single ts/tsx rule mapped to ts-jest', () => {
    const keys = Object.keys(transform)
    expect(keys).toEqual(['^.+\\.tsx?$'])
    expect(transform['^.+\\.tsx?$']).toBe('ts-jest')
  })

  it('transform regex matches .ts and .tsx but not .js or .jsx', () => {
    const pattern = Object.keys(transform)[0]
    const re = new RegExp(pattern)
    expect(re.test('index.ts')).toBe(true)
    expect(re.test('component.tsx')).toBe(true)
    expect(re.test('script.js')).toBe(false)
    expect(re.test('view.jsx')).toBe(false)
  })

  it('roots does not include a generic tests directory', () => {
    expect(roots).not.toContain('<rootDir>/tests')
  })

  it('testMatch specifically includes __tests__ directory pattern', () => {
    expect(testMatch[0]).toBe('**/__tests__/**/*.test.ts')
    expect(testMatch.some(p => p.includes('__tests__'))).toBe(true)
  })

  it('no moduleNameMapper is defined by default', () => {
    expect(config.moduleNameMapper).toBeUndefined()
  })

  it('all arrays are non-empty where expected', () => {
    expect(roots.length).toBeGreaterThan(0)
    expect(testMatch.length).toBeGreaterThan(0)
    expect(moduleFileExtensions.length).toBeGreaterThan(0)
    expect(collectCoverageFrom.length).toBeGreaterThan(0)
    expect(coverageReporters.length).toBeGreaterThan(0)
  })

  it('named imports reflect the same values as in the full config object', () => {
    expect(preset).toBe(config.preset)
    expect(testEnvironment).toBe(config.testEnvironment)
    expect(roots).toEqual(config.roots)
    expect(testMatch).toEqual(config.testMatch)
    expect(moduleFileExtensions).toEqual(config.moduleFileExtensions)
    expect(collectCoverageFrom).toEqual(config.collectCoverageFrom)
    expect(coverageDirectory).toBe(config.coverageDirectory)
    expect(coverageReporters).toEqual(config.coverageReporters)
    expect(transform).toEqual(config.transform)
  })
})