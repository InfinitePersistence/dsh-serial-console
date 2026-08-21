/** Combined browser plugin: mount Remote descriptors and register the Serial tab. */
import type { Context } from '@deepseek-ai/cordis'
import { SerialConsole } from '../client/SerialConsole.js'
import type { UseSerialConversation } from '../client/ai-activity.js'
import { SerialConsoleStore } from '../client/serial-console-store.js'
import { SerialRemoteError } from '../protocol.js'
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
  SerialWaitSnapshotRequest,
} from '../protocol.js'
import serialRemote from './remote.js'

type RemoteResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
    readonly ok: false
    readonly error: { readonly code: string; readonly message: string; readonly details: object }
  }

interface SerialRemoteNamespace {
  listPorts(): Promise<RemoteResult<readonly SerialPortDescriptor[]>>
  connect(request: SerialOpenOptions): Promise<RemoteResult<SerialSnapshot>>
  disconnect(): Promise<RemoteResult<SerialSnapshot>>
  snapshot(request: SerialSnapshotRequest, signal?: AbortSignal): Promise<RemoteResult<SerialSnapshot>>
  waitSnapshot(request: SerialWaitSnapshotRequest, signal?: AbortSignal): Promise<RemoteResult<SerialSnapshot>>
  send(request: SerialSendRequest): Promise<RemoteResult<SerialSendResult>>
  mark(request: SerialMarkRequest): Promise<RemoteResult<SerialMarkerEvent>>
}

interface ClientContext extends Context {
  get(name: 'remote.serialConsole'): SerialRemoteNamespace
  get(name: string): unknown
  remote: {
    $mount(contribution: typeof serialRemote): Promise<() => Promise<void>>
  }
  slots: {
    inject(name: 'conversation.view', register: () => unknown): unknown
    register(
      definition: { readonly name: 'conversation.view'; readonly id: string; readonly order: number; readonly label: string },
      component: (props: SerialConversationViewProps) => React.JSX.Element,
    ): unknown
  }
}

interface SerialConversationViewProps {
  readonly useSession: UseSerialConversation
}

export const inject = ['slots', 'remote']

/**
 * Mount the serial Remote namespace, then expose one conversation Serial tab.
 *
 * This bundle mounts and consumes the namespace in one entry, so it cannot
 * declare `remote.serialConsole` in `inject`: the namespace service only comes
 * into existence while this very apply runs, and a PENDING fiber never runs.
 * Cordis therefore gates `ctx.remote.serialConsole` reads behind that inject
 * declaration. `ctx.get()` is the documented no-inject read path, and after
 * `$mount()` settled the namespace fiber is ACTIVE, so the read is safe.
 */
export async function apply(baseContext: Context): Promise<void> {
  const ctx = baseContext as ClientContext
  const disposeRemote = await ctx.remote.$mount(serialRemote)
  ctx.effect(() => disposeRemote, 'dsh-serial-console: unmount browser Remote')

  const api = ctx.get('remote.serialConsole') as SerialRemoteNamespace
  const remote: SerialConsoleRemote = {
    listPorts: async () => unwrap(await api.listPorts()),
    connect: async request => unwrap(await api.connect(request)),
    disconnect: async () => unwrap(await api.disconnect()),
    snapshot: async (request, signal) => await invokeRemote(
      () => api.snapshot(request ?? {}, signal),
      signal,
    ),
    waitSnapshot: async (request, signal) => await invokeRemote(
      () => api.waitSnapshot(request, signal),
      signal,
    ),
    send: async request => unwrap(await api.send(request)),
    mark: async (label, actor, toolCallId) => unwrap(await api.mark({
      label,
      actor,
      ...(toolCallId === undefined ? {} : { toolCallId }),
    })),
  }
  const store = new SerialConsoleStore(remote)
  ctx.effect(() => () => { store.stop() }, 'dsh-serial-console: stop browser synchronization')

  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'serial-console',
    order: 20,
    label: '串口',
  }, ({ useSession }) => <SerialConsole store={store} useConversation={useSession} />))
}

function unwrap<T>(result: RemoteResult<T>): T {
  if (!result.ok) {
    throw new SerialRemoteError(result.error.code, result.error.message, result.error.details)
  }
  return result.value
}

async function invokeRemote<T>(
  operation: () => Promise<RemoteResult<T>>,
  signal?: AbortSignal,
): Promise<T> {
  let result: RemoteResult<T>
  try {
    result = await operation()
  } catch (error) {
    if (signal?.aborted === true) throw abortReason(signal)
    if (error instanceof SerialRemoteError) throw error
    throw new SerialRemoteError(
      'client-invocation-failed',
      error instanceof Error ? error.message : String(error),
    )
  }
  return unwrap(result)
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  const error = new Error('serial Remote invocation aborted')
  error.name = 'AbortError'
  return error
}
