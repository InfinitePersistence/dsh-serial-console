/**
 * Blueprint only. Move this into a real Harness Client package after Typert
 * has generated @community/dsh-serial-console/remote.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@community/dsh-serial-console/remote'
import { SerialConsole, SerialConsoleStore } from '../../src/client/index.js'
import type { SerialConsoleRemote } from '../../src/protocol.js'

export const inject = ['slots', 'remote', 'remote.serialConsole']

export function apply(ctx: Context): void {
  const api = ctx.remote.serialConsole
  const remote: SerialConsoleRemote = {
    listPorts: async () => unwrap(await api.listPorts({})),
    connect: async request => unwrap(await api.connect(request)),
    disconnect: async () => unwrap(await api.disconnect({})),
    snapshot: async request => unwrap(await api.snapshot(request ?? {})),
    send: async request => unwrap(await api.send(request)),
    mark: async (label, actor, toolCallId) => unwrap(await api.mark({ label, actor, toolCallId })),
  }
  const store = new SerialConsoleStore(remote)
  ctx.effect(() => store.stop, 'ui-serial-console: polling store')
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'serial-console',
    order: 20,
    label: 'Serial',
  }, () => <SerialConsole store={store} />))
}

function unwrap<T>(result: RemoteResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  return result.value
}
