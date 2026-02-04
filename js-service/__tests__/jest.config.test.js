import { describe, it, expect, jest, afterEach } from '@jest/globals'
import config from '../jest.config'

afterEach(() => {
  jest.clearAllMocks()
})

describe('jest.config.js', () => {
  it('exports an object', () => {
    expect(typeof config).toBe('object')
    expect(config).not.toBeNull()
    expect(Array.isArray(config)).toBe(false)
  })

  it('has the expected top-level keys', () => {
    const keys = Object.keys(config).sort()
    expect(keys).toEqual(
      [
        'collectCoverageFrom',
        'coverageDirectory',
        'coverageReporters',
        'moduleFileExtensions',
        'preset',
        'roots',
        'testEnvironment',
        'testMatch',
        'transform'
      ].sort()
    )
  })

  it('sets preset to ts-jest', () => {
    expect(config.preset).toBe('ts-jest')
  })

  it('uses node as testEnvironment', () => {
    expect(config.testEnvironment).toBe('node')
  })

  it('defines correct roots', () => {
    expect(config.roots).toEqual(['<rootDir>/src', '<rootDir>/__tests__'])
    expect(config.roots.every((r) => r.startsWith('<rootDir>/'))).toBe(true)
  })

  it('defines testMatch patterns for TypeScript tests only', () => {
    expect(config.testMatch).toEqual(['**/__tests__/**/*.test.ts', '**/?(*.)+(spec|test).ts'])
    // ensure no .js patterns
    expect(config.testMatch.some((p) => p.includes('.js'))).toBe(false)
  })

  it('moduleFileExtensions contains both ts and js families', () => {
    expect(config.moduleFileExtensions).toEqual(['ts', 'tsx', 'js', 'jsx', 'json', 'node'])
    expect(config.moduleFileExtensions.includes('ts')).toBe(true)
    expect(config.moduleFileExtensions.includes('tsx')).toBe(true)
    expect(config.moduleFileExtensions.includes('js')).toBe(true)
    expect(config.moduleFileExtensions.includes('jsx')).toBe(true)
    expect(config.moduleFileExtensions.includes('json')).toBe(true)
    expect(config.moduleFileExtensions.includes('node')).toBe(true)
  })

  it('collectCoverageFrom includes ts/tsx and excludes d.ts and test files', () => {
    expect(config.collectCoverageFrom).toEqual([
      'src/**/*.{ts,tsx}',
      '!src/**/*.d.ts',
      '!src/**/*.test.ts'
    ])
    const negatives = config.collectCoverageFrom.filter((p) => p.startsWith('!'))
    expect(negatives).toEqual(['!src/**/*.d.ts', '!src/**/*.test.ts'])
  })

  it('has a coverageDirectory of "coverage"', () => {
    expect(config.coverageDirectory).toBe('coverage')
  })

  it('uses correct coverageReporters', () => {
    expect(config.coverageReporters).toEqual(['text', 'json', 'html'])
    expect(config.coverageReporters).toContain('text')
    expect(config.coverageReporters).toContain('json')
    expect(config.coverageReporters).toContain('html')
  })

  it('defines a transform for ts/tsx files using ts-jest', () => {
    expect(typeof config.transform).toBe('object')
    const keys = Object.keys(config.transform)
    expect(keys).toEqual(['^.+\\.tsx?$'])
    expect(config.transform['^.+\\.tsx?$']).toBe('ts-jest')
  })

  it('transform regex matches .ts and .tsx files and not .js/.jsx', () => {
    const pattern = Object.keys(config.transform)[0]
    const re = new RegExp(pattern)
    expect(re.test('file.ts')).toBe(true)
    expect(re.test('file.tsx')).toBe(true)
    expect(re.test('src/components/Button.tsx')).toBe(true)
    expect(re.test('file.js')).toBe(false)
    expect(re.test('file.jsx')).toBe(false)
  })

  it('transform regex also matches .d.ts (reflecting current config)', () => {
    const pattern = Object.keys(config.transform)[0]
    const re = new RegExp(pattern)
    expect(re.test('types.d.ts')).toBe(true)
  })

  it('does not define clearMocks or other unrelated props', () => {
    expect('clearMocks' in config).toBe(false)
    expect('resetMocks' in config).toBe(false)
    expect('restoreMocks' in config).toBe(false)
  })

  it('roots contain the correct directories and only those', () => {
    const roots = config.roots
    expect(roots.length).toBe(2)
    expect(roots[0]).toBe('<rootDir>/src')
    expect(roots[1]).toBe('<rootDir>/__tests__')
  })

  it('testMatch patterns are specific to TypeScript tests', () => {
    const [testsInDir, testsGlob] = config.testMatch
    expect(testsInDir.endsWith('.test.ts')).toBe(true)
    expect(testsGlob.endsWith('.ts')).toBe(true)
    expect(testsInDir.includes('__tests__')).toBe(true)
  })

  it('moduleFileExtensions ordering prioritizes TypeScript before JavaScript', () => {
    const exts = config.moduleFileExtensions
    expect(exts.indexOf('ts')).toBeLessThan(exts.indexOf('js'))
    expect(exts.indexOf('tsx')).toBeLessThan(exts.indexOf('jsx'))
  })
})