/** Combined browser plugin: mount Remote descriptors and register the Serial tab. */
import type { Context } from '@deepseek-ai/cordis'
import { SerialConsole } from '../client/SerialConsole.js'
import { SerialConsoleStore } from '../client/serial-console-store.js'
import type {
  SerialConsoleRemote,
  SerialMarkRequest,
  SerialMarkerEvent,
  SerialOpenOptions,
  SerialPortDescriptor,
  SerialSendRequest,
  SerialSendResult,
  SerialSnapshot,
  SerialSnapshotRequest,
} from '../protocol.js'
import serialRemote from './remote.js'

type RemoteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

interface SerialRemoteNamespace {
  listPorts(): Promise<RemoteResult<readonly SerialPortDescriptor[]>>
  connect(request: SerialOpenOptions): Promise<RemoteResult<SerialSnapshot>>
  disconnect(): Promise<RemoteResult<SerialSnapshot>>
  snapshot(request: SerialSnapshotRequest): Promise<RemoteResult<SerialSnapshot>>
  send(request: SerialSendRequest): Promise<RemoteResult<SerialSendResult>>
  mark(request: SerialMarkRequest): Promise<RemoteResult<SerialMarkerEvent>>
}

interface ClientContext extends Context {
  remote: {
    readonly serialConsole: SerialRemoteNamespace
    $mount(contribution: typeof serialRemote): Promise<() => Promise<void>>
  }
  slots: {
    inject(name: 'conversation.view', register: () => unknown): unknown
    register(
      definition: { readonly name: 'conversation.view'; readonly id: string; readonly order: number; readonly label: string },
      component: () => React.JSX.Element,
    ): unknown
  }
}

export const inject = ['slots', 'remote']

/** Mount the serial Remote namespace, then expose one conversation Serial tab. */
export async function apply(baseContext: Context): Promise<void> {
  const ctx = baseContext as ClientContext
  const disposeRemote = await ctx.remote.$mount(serialRemote)
  ctx.effect(() => disposeRemote, 'dsh-serial-console: unmount browser Remote')

  const api = ctx.remote.serialConsole
  const remote: SerialConsoleRemote = {
    listPorts: async () => unwrap(await api.listPorts()),
    connect: async request => unwrap(await api.connect(request)),
    disconnect: async () => unwrap(await api.disconnect()),
    snapshot: async request => unwrap(await api.snapshot(request ?? {})),
    send: async request => unwrap(await api.send(request)),
    mark: async (label, actor, toolCallId) => unwrap(await api.mark({
      label,
      actor,
      ...(toolCallId === undefined ? {} : { toolCallId }),
    })),
  }
  const store = new SerialConsoleStore(remote)
  ctx.effect(() => () => { store.stop() }, 'dsh-serial-console: stop browser polling')

  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'serial-console',
    order: 20,
    label: '串口',
  }, () => <SerialConsole store={store} />))
}

function unwrap<T>(result: RemoteResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  return result.value
}
