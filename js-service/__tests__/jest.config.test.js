import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals'
import config from '../jest.config'

afterEach(() => {
  jest.clearAllMocks()
})

describe('jest.config.js - basic shape', () => {
  it('exports an object as default (CommonJS module.exports)', () => {
    expect(typeof config).toBe('object')
    expect(config).not.toBeNull()
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

  it('does not contain unexpected extra keys', () => {
    const allowed = new Set([
      'preset',
      'testEnvironment',
      'roots',
      'testMatch',
      'moduleFileExtensions',
      'collectCoverageFrom',
      'coverageDirectory',
      'coverageReporters',
      'transform'
    ])
    Object.keys(config).forEach(key => {
      expect(allowed.has(key)).toBe(true)
    })
  })
})

describe('jest.config.js - preset and environment', () => {
  it('uses ts-jest preset', () => {
    expect(config.preset).toBe('ts-jest')
  })

  it('uses node testEnvironment', () => {
    expect(config.testEnvironment).toBe('node')
  })

  it('keeps preset immutable during tests', () => {
    const originalPreset = config.preset
    config.preset = 'modified-preset' as any
    expect(config.preset).toBe('modified-preset')
    config.preset = originalPreset
    expect(config.preset).toBe('ts-jest')
  })
})

describe('jest.config.js - roots', () => {
  it('defines two roots', () => {
    expect(Array.isArray(config.roots)).toBe(true)
    expect(config.roots.length).toBe(2)
  })

  it('includes src rootDir path', () => {
    expect(config.roots).toContain('<rootDir>/src')
  })

  it('includes __tests__ rootDir path', () => {
    expect(config.roots).toContain('<rootDir>/__tests__')
  })

  it('roots array is ordered: src before __tests__', () => {
    const srcIndex = config.roots.indexOf('<rootDir>/src')
    const testsIndex = config.roots.indexOf('<rootDir>/__tests__')
    expect(srcIndex).toBeGreaterThanOrEqual(0)
    expect(testsIndex).toBeGreaterThanOrEqual(0)
    expect(srcIndex).toBeLessThan(testsIndex)
  })
})

describe('jest.config.js - testMatch patterns', () => {
  it('defines testMatch as an array', () => {
    expect(Array.isArray(config.testMatch)).toBe(true)
  })

  it('includes __tests__ directory pattern', () => {
    const pattern = '**/__tests__/**/*.test.ts'
    expect(config.testMatch).toContain(pattern)
  })

  it('includes generic spec/test filename pattern', () => {
    const pattern = '**/?(*.)+(spec|test).ts'
    expect(config.testMatch).toContain(pattern)
  })

  it('does not include js patterns in testMatch', () => {
    const combined = config.testMatch.join(' ')
    expect(combined.includes('.test.js')).toBe(false)
    expect(combined.includes('.spec.js')).toBe(false)
  })
})

describe('jest.config.js - moduleFileExtensions', () => {
  it('defines moduleFileExtensions as an array', () => {
    expect(Array.isArray(config.moduleFileExtensions)).toBe(true)
  })

  it('supports TypeScript and TSX extensions', () => {
    expect(config.moduleFileExtensions).toEqual(
      expect.arrayContaining(['ts', 'tsx'])
    )
  })

  it('supports JavaScript and JSX extensions', () => {
    expect(config.moduleFileExtensions).toEqual(
      expect.arrayContaining(['js', 'jsx'])
    )
  })

  it('includes json and node extensions', () => {
    expect(config.moduleFileExtensions).toEqual(
      expect.arrayContaining(['json', 'node'])
    )
  })

  it('moduleFileExtensions maintains expected order', () => {
    expect(config.moduleFileExtensions).toEqual([
      'ts',
      'tsx',
      'js',
      'jsx',
      'json',
      'node'
    ])
  })
})

describe('jest.config.js - coverage settings', () => {
  it('collectCoverageFrom is configured as array', () => {
    expect(Array.isArray(config.collectCoverageFrom)).toBe(true)
  })

  it('includes pattern to collect from ts and tsx in src', () => {
    expect(config.collectCoverageFrom).toContain('src/**/*.{ts,tsx}')
  })

  it('excludes type declaration files from coverage', () => {
    expect(config.collectCoverageFrom).toContain('!src/**/*.d.ts')
  })

  it('excludes test files from coverage', () => {
    expect(config.collectCoverageFrom).toContain('!src/**/*.test.ts')
  })

  it('uses coverage directory named coverage', () => {
    expect(config.coverageDirectory).toBe('coverage')
  })

  it('has expected coverage reporters: text, json, html', () => {
    expect(config.coverageReporters).toEqual(
      expect.arrayContaining(['text', 'json', 'html'])
    )
    expect(config.coverageReporters.length).toBe(3)
  })
})

describe('jest.config.js - transform settings', () => {
  it('defines transform as an object', () => {
    expect(typeof config.transform).toBe('object')
    expect(config.transform).not.toBeNull()
  })

  it('uses ts-jest for TypeScript files', () => {
    expect(config.transform['^.+\\.tsx?$']).toBe('ts-jest')
  })

  it('transform does not configure non-TS patterns', () => {
    const keys = Object.keys(config.transform)
    expect(keys).toEqual(['^.+\\.tsx?$'])
  })
})

describe('jest.config.js - immutability and shared reference behavior', () => {
  let originalConfig: any

  beforeEach(() => {
    originalConfig = { ...config }
  })

  it('allows modification of coverageDirectory at runtime', () => {
    const previous = config.coverageDirectory
    config.coverageDirectory = 'custom-coverage'
    expect(config.coverageDirectory).toBe('custom-coverage')
    config.coverageDirectory = previous
    expect(config.coverageDirectory).toBe('coverage')
  })

  it('mutating moduleFileExtensions affects the same reference', () => {
    const originalLength = config.moduleFileExtensions.length
    config.moduleFileExtensions.push('mjs' as any)
    expect(config.moduleFileExtensions.length).toBe(originalLength + 1)
    config.moduleFileExtensions.pop()
    expect(config.moduleFileExtensions.length).toBe(originalLength)
  })

  it('preserves core properties after local mutations are reverted', () => {
    config.preset = 'changed' as any
    config.testEnvironment = 'jsdom' as any
    config.preset = originalConfig.preset
    config.testEnvironment = originalConfig.testEnvironment

    expect(config.preset).toBe('ts-jest')
    expect(config.testEnvironment).toBe('node')
  })
})

describe('jest.config.js - snapshot of full configuration', () => {
  it('matches the expected configuration snapshot', () => {
    expect(config).toEqual({
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
    })
  })
})