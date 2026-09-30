// Exercise emitted decorators and the published Cordis/Typert/tool runtime.
// This deliberately runs after tsc, outside Vitest's source transformer.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { validateTypertManifest } from '@deepseek-ai/dsh-typert-loader'
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { SerialConsoleService } from '../dist/harness/host.js'
import * as serialTools from '../dist/harness/tool.js'
import { TYPERT } from '../dist/harness/typert.js'

const directory = await mkdtemp(join(tmpdir(), 'dsh-serial-runtime-'))
const ctx = new Context()
try {
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, {})
  const host = await ctx.plugin(SerialConsoleService, { logDirectory: directory })
  const tools = await ctx.plugin(serialTools)
  const registry = ctx.get('typert')
  assert.ok(registry, 'Typert registry must mount')
  const unregister = registry.register(validateTypertManifest(TYPERT.package, TYPERT))
  const service = ctx.get('serialConsole')
  assert.ok(service, 'Serial Host must mount')
  assert.equal(service.snapshot({}).status, 'disconnected')
  assert.deepEqual(remoteMethods(service).map(method => method.method).sort(),
    TYPERT.invocations.map(descriptor => descriptor.method).sort())
  const runtime = ctx.get('tools')
  assert.ok(runtime, 'Tool runtime must mount')
  for (const name of ['serial_list_ports', 'serial_connect', 'serial_send', 'serial_read', 'serial_expect', 'serial_mark', 'serial_disconnect']) {
    assert.ok(runtime.get(name), `${name} must register`)
  }
  const wait = service.waitSnapshot({ afterSeq: 0, waitMs: 1_000 }, new AbortController().signal)
  const rejected = assert.rejects(wait, /closed/)
  await tools.dispose()
  await host.dispose()
  await rejected
  assert.equal(runtime.get('serial_read'), undefined)
  await unregister()
  console.log('DSH compatibility passed: Host, Typert manifest, seven tools, waiter cleanup')
} finally {
  await ctx.fiber.dispose()
  await rm(directory, { recursive: true, force: true })
}
