import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { TYPERT_REMOTE } from '../src/harness/remote.js'
import { TYPERT } from '../src/harness/typert.js'

describe('DSH installable bundle', () => {
  it('declares the profile patch and prebuilt browser client', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      dsh?: { bundle?: { patch?: string }; client?: { platform?: string } }
      exports?: Record<string, unknown>
      files?: string[]
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.dsh?.client?.platform).toBe('web')
    expect(manifest.exports).toHaveProperty('./client')
    expect(manifest.exports).toHaveProperty('./tool')
    expect(manifest.exports).toHaveProperty('./typert')
    expect(manifest.files).toContain('cordis.patch.yml')
    expect(manifest.dependencies).not.toHaveProperty('serialport')
    expect(manifest.devDependencies).toHaveProperty('serialport')
  })

  it('mounts Host and model-tool rows from the profile layer', () => {
    const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    expect(patch).toContain("name: '@infinitepersistence/dsh-serial-console'")
    expect(patch).toContain("name: '@infinitepersistence/dsh-serial-console/tool'")
  })

  it('ships matching Host and browser Remote descriptors', () => {
    expect(TYPERT.package).toBe('@infinitepersistence/dsh-serial-console')
    expect(TYPERT_REMOTE.package).toBe(TYPERT.package)
    expect(TYPERT_REMOTE.descriptors.map(descriptor => descriptor.method)).toEqual([
      'connect',
      'disconnect',
      'listPorts',
      'mark',
      'send',
      'snapshot',
      'waitSnapshot',
    ])
    expect(TYPERT.invocations).toBe(TYPERT_REMOTE.descriptors)
  })

  it('rejects invalid snapshot cursors, limits, and wait durations at the Remote boundary', () => {
    const snapshotDescriptor = TYPERT_REMOTE.descriptors.find(descriptor => descriptor.method === 'snapshot')
    const waitDescriptor = TYPERT_REMOTE.descriptors.find(descriptor => descriptor.method === 'waitSnapshot')
    const snapshotSchema = snapshotDescriptor?.parameters[0]?.codec.schema as {
      parse(value: unknown): unknown
    }
    const waitSchema = waitDescriptor?.parameters[0]?.codec.schema as {
      parse(value: unknown): unknown
    }

    expect(() => { snapshotSchema.parse({ afterSeq: -1, limit: 1 }) }).toThrow()
    expect(() => { snapshotSchema.parse({ afterSeq: 0.5, limit: 1 }) }).toThrow()
    expect(() => { snapshotSchema.parse({ afterSeq: 0, limit: 0 }) }).toThrow()
    expect(() => { waitSchema.parse({ afterSeq: 0, limit: 1, waitMs: 1_001 }) }).toThrow()
    expect(waitSchema.parse({ afterSeq: 0, limit: 1, waitMs: 0 })).toEqual({
      afterSeq: 0,
      limit: 1,
      waitMs: 0,
    })
  })
})
