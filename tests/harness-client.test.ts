import type { Context } from '@deepseek-ai/cordis'
import type { ReactElement } from 'react'
import { describe, expect, it } from 'vitest'
import { apply } from '../src/harness/client.js'
import type { SerialConsoleStore } from '../src/client/serial-console-store.js'
import type { SerialConversationSnapshot, UseSerialConversation } from '../src/client/ai-activity.js'
import type {
  SerialConsoleRemote,
  SerialSnapshot,
  SerialSnapshotRequest,
} from '../src/protocol.js'

type RemoteResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
    readonly ok: false
    readonly error: { readonly code: string; readonly message: string; readonly details: object }
  }

type SnapshotInvocation = (
  request: SerialSnapshotRequest,
  signal?: AbortSignal,
) => Promise<RemoteResult<SerialSnapshot>>

describe('Harness client adapter', () => {
  it('turns a direct Typert Promise rejection into a persistent synchronization fault', async () => {
    const store = await mountedStore(async () => {
      throw new Error('client assembly rejected the call')
    })

    await store.refresh()

    expect(store.getSnapshot().syncFault).toContain('client-invocation-failed')
    expect(store.getSnapshot().syncFault).toContain('client assembly rejected the call')
  })

  it('keeps a returned opaque internal error on the transient retry path', async () => {
    const store = await mountedStore(async () => ({
      ok: false,
      error: { code: 'internal', message: 'carrier unavailable', details: {} },
    }))

    await store.refresh()

    expect(store.getSnapshot().syncFault).toBeUndefined()
    expect(store.getSnapshot().syncError).toBe('carrier unavailable')
  })

  it('preserves caller cancellation instead of reporting an assembly failure', async () => {
    const store = await mountedStore(async (_request, signal) => await new Promise((_resolve, reject) => {
      const rejectAbort = () => { reject(new Error('carrier observed cancellation')) }
      if (signal?.aborted === true) rejectAbort()
      else signal?.addEventListener('abort', rejectAbort, { once: true })
    }))
    const remote = (store as unknown as { readonly remote: SerialConsoleRemote }).remote
    const controller = new AbortController()
    const invocation = remote.snapshot({}, controller.signal)

    controller.abort(new Error('cancelled by caller'))

    await expect(invocation).rejects.toThrow('cancelled by caller')
  })
})

async function mountedStore(snapshotInvocation: SnapshotInvocation): Promise<SerialConsoleStore> {
  let view: ((props: { readonly useSession: UseSerialConversation }) => ReactElement<{
    store: SerialConsoleStore
    useConversation: UseSerialConversation
  }>) | undefined
  const empty = immediateSnapshot()
  const api = {
    listPorts: async () => ({ ok: true, value: [] } as const),
    connect: async () => ({ ok: true, value: empty } as const),
    disconnect: async () => ({ ok: true, value: empty } as const),
    snapshot: snapshotInvocation,
    waitSnapshot: snapshotInvocation,
    send: async () => ({
      ok: true,
      value: { sessionId: 'session-1', seq: 1, byteLength: 1 },
    } as const),
    mark: async () => ({
      ok: true,
      value: {
        type: 'marker',
        sessionId: 'session-1',
        seq: 1,
        timestamp: 1,
        monotonicMs: 1,
        actor: 'user',
        label: 'test',
      },
    } as const),
  }
  const ctx = {
    get: (name: string) => {
      if (name === 'remote.serialConsole') return api
      return undefined
    },
    remote: {
      $mount: async () => async () => undefined,
    },
    effect: () => undefined,
    slots: {
      inject: (_name: string, register: () => unknown) => register(),
      register: (_definition: unknown, component: typeof view) => {
        view = component
        return undefined
      },
    },
  }

  await apply(ctx as unknown as Context)
  if (view === undefined) throw new Error('serial view was not registered')
  const useSession: UseSerialConversation = selector => selector(emptyConversation())
  const element = view({ useSession })
  if (element.props.useConversation !== useSession) {
    throw new Error('serial view did not receive the DSH conversation selector')
  }
  return element.props.store
}

function emptyConversation(): SerialConversationSnapshot {
  return {
    running: false,
    partial: null,
    nodes: [],
    runningCalls: [],
    lastAgentError: null,
  }
}

function immediateSnapshot(): SerialSnapshot {
  return {
    status: 'disconnected',
    earliestSeq: 1,
    nextSeq: 1,
    truncated: false,
    events: [],
  }
}
