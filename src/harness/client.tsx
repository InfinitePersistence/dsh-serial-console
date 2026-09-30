/** Combined browser plugin: mount Remote descriptors and register the Serial tab. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { useMemo } from 'react'
import { SerialConsole } from '../client/SerialConsole.js'
import { deriveAiActivity } from '../client/ai-activity.js'
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
export async function apply(ctx: Context): Promise<void> {
  const disposeRemote = await ctx.remote.$mount(serialRemote)
  ctx.effect(() => disposeRemote, 'dsh-serial-console: unmount browser Remote')

  const api = ctx.get('remote.serialConsole') as SerialRemoteNamespace | undefined
  if (api === undefined) throw new Error('Serial Remote namespace was not mounted')
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
  }, ({ useSession, useChat }) => <SerialConversationView store={store} useSession={useSession} useChat={useChat} />))
}

/** Session owns lifecycle; Chat owns streaming content and tool projections. */
export function SerialConversationView({ store, useSession, useChat }: Pick<ConvViewProps, 'useSession' | 'useChat'> & {
  readonly store: SerialConsoleStore
}) {
  const running = useSession(snapshot => snapshot.running)
  const lastAgentError = useSession(snapshot => snapshot.lastAgentError)
  const legacy = useChat(snapshot => snapshot.legacy)
  const activity = useMemo(() => deriveAiActivity({
    running,
    lastAgentError,
    nodes: legacy.nodes,
    partial: legacy.partial,
    runningCalls: legacy.runningCalls,
  }), [running, lastAgentError, legacy])
  return <SerialConsole store={store} aiActivity={activity} />
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
