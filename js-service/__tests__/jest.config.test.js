import { describe, it, expect, jest, afterEach } from '@jest/globals'
import config from '../jest.config'

afterEach(() => {
  jest.clearAllMocks()
})

describe('jest.config.js - export shape', () => {
  it('exports a plain object', () => {
    expect(typeof config).toBe('object')
    expect(config).not.toBeNull()
    expect(Array.isArray(config)).toBe(false)
  })

  it('has expected top-level keys only', () => {
    const keys = Object.keys(config).sort()
    const expected = [
      'collectCoverageFrom',
      'coverageDirectory',
      'coverageReporters',
      'moduleFileExtensions',
      'preset',
      'roots',
      'testEnvironment',
      'testMatch',
      'transform',
    ].sort()
    expect(keys).toEqual(expected)
  })

  it('does not define optional fields like moduleNameMapper or setup files', () => {
    expect('moduleNameMapper' in config).toBe(false)
    expect('setupFiles' in config).toBe(false)
    expect('setupFilesAfterEnv' in config).toBe(false)
    expect('collectCoverage' in config).toBe(false)
    expect('extensionsToTreatAsEsm' in config).toBe(false)
  })
})

describe('jest.config.js - core settings', () => {
  it('preset is ts-jest', () => {
    expect(config.preset).toBe('ts-jest')
  })

  it('testEnvironment is node', () => {
    expect(config.testEnvironment).toBe('node')
  })
})

describe('jest.config.js - roots', () => {
  it('roots are correct and ordered', () => {
    expect(config.roots).toEqual(['<rootDir>/src', '<rootDir>/__tests__'])
  })

  it('roots entries start with <rootDir>/', () => {
    for (const root of config.roots) {
      expect(root.startsWith('<rootDir>/')).toBe(true)
    }
  })
})

describe('jest.config.js - testMatch', () => {
  it('testMatch patterns are correct and ts-only', () => {
    expect(config.testMatch).toEqual(['**/__tests__/**/*.test.ts', '**/?(*.)+(spec|test).ts'])
    for (const pattern of config.testMatch) {
      expect(pattern.endsWith('.ts')).toBe(true)
    }
  })

  it('testMatch includes both spec and test patterns', () => {
    const joined = config.testMatch.join(' ')
    expect(joined.includes('spec')).toBe(true)
    expect(joined.includes('test')).toBe(true)
  })
})

describe('jest.config.js - moduleFileExtensions', () => {
  it('moduleFileExtensions are correct and include node', () => {
    expect(config.moduleFileExtensions).toEqual(['ts', 'tsx', 'js', 'jsx', 'json', 'node'])
    expect(config.moduleFileExtensions).toContain('node')
  })
})

describe('jest.config.js - coverage', () => {
  it('collectCoverageFrom globs include src ts/tsx but exclude d.ts and *.test.ts', () => {
    expect(config.collectCoverageFrom).toContain('src/**/*.{ts,tsx}')
    expect(config.collectCoverageFrom).toContain('!src/**/*.d.ts')
    expect(config.collectCoverageFrom).toContain('!src/**/*.test.ts')
    for (const glob of config.collectCoverageFrom) {
      expect(glob.startsWith('src/') || glob.startsWith('!src/')).toBe(true)
    }
  })

  it('coverageDirectory is coverage', () => {
    expect(config.coverageDirectory).toBe('coverage')
  })

  it('coverageReporters include text, json, html and only those', () => {
    expect(config.coverageReporters).toEqual(['text', 'json', 'html'])
  })
})

describe('jest.config.js - transform', () => {
  it('transform maps ts/tsx to ts-jest with correct regex string', () => {
    expect(typeof config.transform).toBe('object')
    const keys = Object.keys(config.transform)
    expect(keys).toEqual(['^.+\\.tsx?$'])
    expect(config.transform['^.+\\.tsx?$']).toBe('ts-jest')
  })

  it('transform regex matches .ts and .tsx files and not .js', () => {
    const regexStr = Object.keys(config.transform)[0]
    const re = new RegExp(regexStr)
    expect(re.test('index.ts')).toBe(true)
    expect(re.test('components/Button.tsx')).toBe(true)
    expect(re.test('script.js')).toBe(false)
    expect(re.test('script.jsx')).toBe(false)
  })
})

describe('jest.config.js - module caching behavior', () => {
  it('returns same instance within same module registry', () => {
    jest.isolateModules(() => {
      const a = require('../jest.config')
      const b = require('../jest.config')
      expect(a).toBe(b)
    })
  })

  it('returns a fresh instance across isolated module runs', () => {
    let ref1 = null
    let ref2 = null

    jest.isolateModules(() => {
      ref1 = require('../jest.config')
    })
    jest.isolateModules(() => {
      ref2 = require('../jest.config')
    })

    expect(ref1).not.toBe(ref2)
    // But they should be deeply equal in content
    expect(ref1).toEqual(ref2)
  })
})