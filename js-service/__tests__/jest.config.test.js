import { describe, it, expect, jest, afterEach } from '@jest/globals'
import config from '../jest.config'

afterEach(() => {
  jest.clearAllMocks()
})

describe('jest.config.js configuration', () => {
  it('exports an object', () => {
    expect(typeof config).toBe('object')
    expect(config).not.toBeNull()
  })

  it('has the expected top-level keys only', () => {
    const keys = Object.keys(config).sort()
    expect(keys).toEqual([
      'collectCoverageFrom',
      'coverageDirectory',
      'coverageReporters',
      'moduleFileExtensions',
      'preset',
      'roots',
      'testEnvironment',
      'testMatch',
      'transform'
    ])
  })

  it('uses ts-jest preset', () => {
    expect(config.preset).toBe('ts-jest')
  })

  it('sets node as the test environment', () => {
    expect(config.testEnvironment).toBe('node')
  })

  it('has correct roots configured', () => {
    expect(Array.isArray(config.roots)).toBe(true)
    expect(config.roots).toContain('<rootDir>/src')
    expect(config.roots).toContain('<rootDir>/__tests__')
    expect(config.roots.length).toBe(2)
  })

  it('has correct testMatch patterns', () => {
    expect(Array.isArray(config.testMatch)).toBe(true)
    expect(config.testMatch).toContain('**/__tests__/**/*.test.ts')
    expect(config.testMatch).toContain('**/?(*.)+(spec|test).ts')
    expect(config.testMatch.length).toBe(2)
  })

  it('supports expected module file extensions', () => {
    expect(config.moduleFileExtensions).toEqual([
      'ts',
      'tsx',
      'js',
      'jsx',
      'json',
      'node'
    ])
  })

  it('collectCoverageFrom includes TypeScript sources and excludes decl and test files', () => {
    expect(Array.isArray(config.collectCoverageFrom)).toBe(true)
    expect(config.collectCoverageFrom).toContain('src/**/*.{ts,tsx}')
    expect(config.collectCoverageFrom).toContain('!src/**/*.d.ts')
    expect(config.collectCoverageFrom).toContain('!src/**/*.test.ts')
    expect(config.collectCoverageFrom.length).toBe(3)
  })

  it('outputs coverage to the coverage directory', () => {
    expect(config.coverageDirectory).toBe('coverage')
  })

  it('has expected coverage reporters', () => {
    expect(config.coverageReporters).toEqual(['text', 'json', 'html'])
  })

  it('has a transform configuration for ts/tsx files using ts-jest', () => {
    expect(typeof config.transform).toBe('object')
    const keys = Object.keys(config.transform)
    expect(keys).toEqual(['^.+\\.tsx?$'])
    expect(config.transform['^.+\\.tsx?$']).toBe('ts-jest')
  })

  it('transform regex matches .ts files', () => {
    const key = Object.keys(config.transform)[0]
    const re = new RegExp(key)
    expect(re.test('file.ts')).toBe(true)
    expect(re.test('src/index.ts')).toBe(true)
  })

  it('transform regex matches .tsx files', () => {
    const key = Object.keys(config.transform)[0]
    const re = new RegExp(key)
    expect(re.test('component.tsx')).toBe(true)
    expect(re.test('src/components/app.tsx')).toBe(true)
  })

  it('transform regex does not match .js or .jsx files', () => {
    const key = Object.keys(config.transform)[0]
    const re = new RegExp(key)
    expect(re.test('index.js')).toBe(false)
    expect(re.test('component.jsx')).toBe(false)
  })

  it('does not include unexpected properties', () => {
    const unexpectedKeys = [
      'collectCoverage',
      'coveragePathIgnorePatterns',
      'modulePathIgnorePatterns',
      'moduleNameMapper',
      'transformIgnorePatterns',
      'setupFiles',
      'setupFilesAfterEnv'
    ]
    for (const k of unexpectedKeys) {
      expect(Object.prototype.hasOwnProperty.call(config, k)).toBe(false)
    }
  })

  it('all configured arrays are non-empty and contain strings', () => {
    const arrayProps = [
      'roots',
      'testMatch',
      'moduleFileExtensions',
      'collectCoverageFrom',
      'coverageReporters'
    ] as const

    for (const prop of arrayProps) {
      const arr = (config as any)[prop]
      expect(Array.isArray(arr)).toBe(true)
      expect(arr.length).toBeGreaterThan(0)
      for (const item of arr) {
        expect(typeof item).toBe('string')
        expect(item.length).toBeGreaterThan(0)
      }
    }
  })

  it('ensures no duplicate entries in array properties', () => {
    const arraysToCheck = [
      config.roots,
      config.testMatch,
      config.moduleFileExtensions,
      config.collectCoverageFrom,
      config.coverageReporters
    ]
    for (const arr of arraysToCheck) {
      const set = new Set(arr)
      expect(set.size).toBe(arr.length)
    }
  })

  it('paths in roots start with <rootDir>/', () => {
    for (const r of config.roots) {
      expect(r.startsWith('<rootDir>/')).toBe(true)
    }
  })
})