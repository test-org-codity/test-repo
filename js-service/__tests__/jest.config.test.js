import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals'
import config from '../jest.config'

afterEach(() => {
  jest.clearAllMocks()
})

describe('jest.config.js', () => {
  it('exports an object', () => {
    expect(typeof config).toBe('object')
    expect(config).not.toBeNull()
  })

  it('has the exact top-level keys', () => {
    const keys = Object.keys(config).sort()
    expect(keys).toEqual(
      [
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
    )
  })

  it('sets preset to ts-jest', () => {
    expect(config.preset).toBe('ts-jest')
  })

  it('sets testEnvironment to node', () => {
    expect(config.testEnvironment).toBe('node')
  })

  it('defines roots correctly', () => {
    expect(Array.isArray(config.roots)).toBe(true)
    expect(config.roots).toEqual(['<rootDir>/src', '<rootDir>/__tests__'])
    for (const r of config.roots) {
      expect(r.startsWith('<rootDir>/')).toBe(true)
    }
  })

  it('defines testMatch correctly', () => {
    expect(Array.isArray(config.testMatch)).toBe(true)
    expect(config.testMatch).toEqual(['**/__tests__/**/*.test.ts', '**/?(*.)+(spec|test).ts'])
  })

  it('defines moduleFileExtensions correctly', () => {
    expect(config.moduleFileExtensions).toEqual(['ts', 'tsx', 'js', 'jsx', 'json', 'node'])
    expect(config.moduleFileExtensions.length).toBe(6)
    expect(config.moduleFileExtensions.includes('ts')).toBe(true)
    expect(config.moduleFileExtensions.includes('tsx')).toBe(true)
    expect(config.moduleFileExtensions.includes('js')).toBe(true)
    expect(config.moduleFileExtensions.includes('jsx')).toBe(true)
    expect(config.moduleFileExtensions.includes('json')).toBe(true)
    expect(config.moduleFileExtensions.includes('node')).toBe(true)
  })

  it('defines collectCoverageFrom with expected inclusions and exclusions', () => {
    expect(Array.isArray(config.collectCoverageFrom)).toBe(true)
    expect(config.collectCoverageFrom).toEqual([
      'src/**/*.{ts,tsx}',
      '!src/**/*.d.ts',
      '!src/**/*.test.ts'
    ])
    const exclusions = config.collectCoverageFrom.filter((p) => p.startsWith('!'))
    expect(exclusions).toEqual(['!src/**/*.d.ts', '!src/**/*.test.ts'])
  })

  it('sets coverageDirectory correctly', () => {
    expect(config.coverageDirectory).toBe('coverage')
  })

  it('sets coverageReporters correctly', () => {
    expect(config.coverageReporters).toEqual(['text', 'json', 'html'])
    expect(config.coverageReporters.includes('text')).toBe(true)
    expect(config.coverageReporters.includes('json')).toBe(true)
    expect(config.coverageReporters.includes('html')).toBe(true)
  })

  it('defines transform mapping with a single regex key for ts/tsx handled by ts-jest', () => {
    expect(typeof config.transform).toBe('object')
    expect(config.transform).not.toBeNull()
    const entries = Object.entries(config.transform)
    expect(entries.length).toBe(1)
    const [pattern, transformer] = entries[0]
    expect(pattern).toBe('^.+\\.tsx?$')
    expect(transformer).toBe('ts-jest')
  })

  it('transform regex matches .ts files', () => {
    const pattern = Object.keys(config.transform)[0]
    const re = new RegExp(pattern)
    expect(re.test('index.ts')).toBe(true)
    expect(re.test('nested/path/file.ts')).toBe(true)
  })

  it('transform regex matches .tsx files', () => {
    const pattern = Object.keys(config.transform)[0]
    const re = new RegExp(pattern)
    expect(re.test('Component.tsx')).toBe(true)
    expect(re.test('nested/Component.tsx')).toBe(true)
  })

  it('transform regex matches .d.ts files', () => {
    const pattern = Object.keys(config.transform)[0]
    const re = new RegExp(pattern)
    expect(re.test('types.d.ts')).toBe(true)
  })

  it('transform regex does not match .js files', () => {
    const pattern = Object.keys(config.transform)[0]
    const re = new RegExp(pattern)
    expect(re.test('index.js')).toBe(false)
    expect(re.test('file.jsx')).toBe(false)
  })

  it('deep equality of the full config object matches expected structure', () => {
    const expected = {
      preset: 'ts-jest',
      testEnvironment: 'node',
      roots: ['<rootDir>/src', '<rootDir>/__tests__'],
      testMatch: ['**/__tests__/**/*.test.ts', '**/?(*.)+(spec|test).ts'],
      moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
      collectCoverageFrom: [
        'src/**/*.{ts,tsx}',
        '!src/**/*.d.ts',
        '!src/**/*.test.ts'
      ],
      coverageDirectory: 'coverage',
      coverageReporters: ['text', 'json', 'html'],
      transform: {
        '^.+\\.tsx?$': 'ts-jest'
      }
    }
    expect(config).toEqual(expected)
  })

  it('does not include unexpected optional config fields', () => {
    const unexpectedKeys = [
      'moduleNameMapper',
      'setupFiles',
      'setupFilesAfterEnv',
      'globals',
      'testPathIgnorePatterns',
      'coveragePathIgnorePatterns'
    ]
    for (const key of unexpectedKeys) {
      expect(Object.prototype.hasOwnProperty.call(config, key)).toBe(false)
    }
  })
})