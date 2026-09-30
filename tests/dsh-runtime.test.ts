import { readFileSync } from 'node:fs'
import { evaluatePluginCompatibility } from '@deepseek-ai/dsh-app-boot'
import { validateTypertManifest } from '@deepseek-ai/dsh-typert-loader'
import { describe, expect, it } from 'vitest'
import { TYPERT } from '../src/harness/typert.js'

describe('DSH 0.2 published runtime compatibility', () => {
  it('passes the official install preflight and rejects the old runtime', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    expect(evaluatePluginCompatibility(manifest, {}, '0.2.0-rc.2')).toBeUndefined()
    expect(evaluatePluginCompatibility(manifest, {}, '0.1.0-rc.7')).toBeDefined()
  })

  it('passes the official Typert manifest validator', () => {
    expect(validateTypertManifest(TYPERT.package, TYPERT)).toBe(TYPERT)
    for (const descriptor of TYPERT.invocations) {
      expect(descriptor.result.mode).toBe('strict')
      if (descriptor.result.mode === 'strict') expect(descriptor.result.create().parse).toBeTypeOf('function')
    }
  })

})
