import { describe, expect, it, vi } from 'vitest'
import {
  SERIAL_WAIT_SNAPSHOT_CAPABILITY,
  SerialRemoteError,
} from '../src/protocol.js'
import type {
  SerialActor,
  SerialConsoleRemote,
  SerialEvent,
  SerialMarkerEvent,
  SerialOpenOptions,
  SerialPortDescriptor,
  SerialSendRequest,
  SerialSnapshot,
  SerialSnapshotRequest,
  SerialWaitSnapshotRequest,
} from '../src/protocol.js'
import { SerialConsoleStore } from '../src/client/serial-console-store.js'

type SnapshotOutcome =
  | SerialSnapshot
  | Error
  | ((signal?: AbortSignal) => Promise<SerialSnapshot>)

class FakeRemote implements SerialConsoleRemote {
  readonly requests: SerialSnapshotRequest[] = []
  readonly waitRequests: SerialWaitSnapshotRequest[] = []
  readonly waitSignals: Array<AbortSignal | undefined> = []
  readonly snapshots: SnapshotOutcome[] = []
  readonly waitSnapshots: SnapshotOutcome[] = []
  readonly sends: SerialSendRequest[] = []
  sendError: Error | undefined
  activeWaiters = 0
  maxActiveWaiters = 0
  private nextSendSeq = 1

  async listPorts(): Promise<readonly SerialPortDescriptor[]> {
    return [{ path: 'COM_TEST' }]
  }

  async connect(options: SerialOpenOptions): Promise<SerialSnapshot> {
    return capableSnapshot([], { sessionId: 'session-1', status: 'connected', port: options })
  }

  async disconnect(): Promise<SerialSnapshot> {
    return capableSnapshot([], { sessionId: 'session-1', status: 'disconnected' })
  }

  async snapshot(request: SerialSnapshotRequest = {}, signal?: AbortSignal): Promise<SerialSnapshot> {
    this.requests.push(request)
    const result = await resolveSnapshotOutcome(
      this.snapshots.shift() ?? snapshot([], { nextSeq: this.nextSendSeq }),
      signal,
    )
    this.nextSendSeq = Math.max(this.nextSendSeq, result.nextSeq)
    return result
  }

  async waitSnapshot(request: SerialWaitSnapshotRequest, signal?: AbortSignal): Promise<SerialSnapshot> {
    this.waitRequests.push(request)
    this.waitSignals.push(signal)
    this.activeWaiters += 1
    this.maxActiveWaiters = Math.max(this.maxActiveWaiters, this.activeWaiters)
    try {
      return await resolveSnapshotOutcome(
        this.waitSnapshots.shift() ?? (currentSignal => waitUntilAbort(currentSignal)),
        signal,
      )
    } finally {
      this.activeWaiters -= 1
    }
  }

  async send(request: SerialSendRequest): Promise<{ sessionId: string; seq: number; byteLength: number }> {
    this.sends.push(request)
    if (this.sendError !== undefined) throw this.sendError
    return { sessionId: 'session-1', seq: this.nextSendSeq++, byteLength: 1 }
  }

  async mark(label: string, _actor: SerialActor): Promise<SerialMarkerEvent> {
    return {
      type: 'marker', sessionId: 'session-1', seq: 1,
      timestamp: 1, monotonicMs: 1, actor: 'user', label,
    }
  }
}

describe('SerialConsoleStore', () => {
  it('merges incremental cursor batches without duplicating events', async () => {
    const remote = new FakeRemote()
    remote.snapshots.push(snapshot([rx(1, 'one')]), snapshot([rx(2, 'two')]))
    const store = new SerialConsoleStore(remote)

    await store.refresh()
    await store.refresh()

    expect(store.getSnapshot().events.map(event => event.seq)).toEqual([1, 2])
    expect(remote.requests).toEqual([
      { afterSeq: 0, limit: 2_000 },
      { afterSeq: 1, limit: 2_000 },
    ])
  })

  it('preserves state and event references for an empty unchanged snapshot', async () => {
    const remote = new FakeRemote()
    const port = { path: 'COM_TEST', baudRate: 115_200 } as const
    remote.snapshots.push(
      snapshot([rx(1, 'one')], { port }),
      snapshot([], { port: { ...port }, earliestSeq: 1, nextSeq: 2 }),
      snapshot([], { status: 'disconnected', port: { ...port }, earliestSeq: 1, nextSeq: 2 }),
    )
    const store = new SerialConsoleStore(remote)

    await store.refresh()
    const before = store.getSnapshot()
    let notifications = 0
    const dispose = store.subscribe(() => { notifications += 1 })

    await store.refresh()

    expect(store.getSnapshot()).toBe(before)
    expect(store.getSnapshot().events).toBe(before.events)
    expect(notifications).toBe(0)

    await store.refresh()

    expect(store.getSnapshot()).not.toBe(before)
    expect(store.getSnapshot().events).toBe(before.events)
    expect(store.getSnapshot().remote.status).toBe('disconnected')
    expect(notifications).toBe(1)
    dispose()
  })

  it('replaces an expired event window and retains a visible gap flag', async () => {
    const remote = new FakeRemote()
    remote.snapshots.push(
      snapshot([rx(1, 'old')]),
      snapshot([rx(5, 'retained')], { earliestSeq: 5, nextSeq: 6, truncated: true }),
    )
    const store = new SerialConsoleStore(remote)

    await store.refresh()
    await store.refresh()

    expect(store.getSnapshot().events.map(event => event.seq)).toEqual([5])
    expect(store.getSnapshot().gapDetected).toBe(true)
  })

  it('retains 1500000 and ignores stale disconnected port values', async () => {
    const remote = new FakeRemote()
    const store = new SerialConsoleStore(remote, { initialBaudRate: 1_500_000 })
    await store.loadPorts()
    store.setLineEnding('crlf')
    remote.snapshots.push(snapshot([], {
      status: 'disconnected',
      port: { path: 'COM_STALE', baudRate: 115_200 },
    }))

    await store.refresh()

    expect(store.getSnapshot()).toMatchObject({
      selectedPath: 'COM_TEST', baudRate: '1500000', lineEnding: 'crlf',
    })
  })

  it('forwards xterm text and binary reports through the same FIFO', async () => {
    const remote = new FakeRemote()
    const store = new SerialConsoleStore(remote)

    await Promise.all([
      store.sendTerminalText('grep "xwse" /va'),
      store.sendTerminalText('\t'),
      store.sendTerminalText('\u001b[D'),
      store.sendTerminalText('\r'),
      store.sendTerminalBinary('gA=='),
    ])

    expect(remote.sends).toEqual([
      { actor: 'user', text: 'grep "xwse" /va', lineEnding: 'none' },
      { actor: 'user', text: '\t', lineEnding: 'none' },
      { actor: 'user', text: '\u001b[D', lineEnding: 'none' },
      { actor: 'user', text: '\r', lineEnding: 'none' },
      { actor: 'user', dataBase64: 'gA==', lineEnding: 'none' },
    ])
  })

  it('publishes a write error and clears it after the next successful input', async () => {
    const remote = new FakeRemote()
    const store = new SerialConsoleStore(remote)
    remote.sendError = new Error('write failed')

    await expect(store.sendTerminalText('x')).rejects.toThrow('write failed')
    expect(store.getSnapshot().lastError).toBe('write failed')
    remote.sendError = undefined
    await store.sendTerminalText('y')
    expect(store.getSnapshot().lastError).toBeUndefined()
  })

  it('uses 150ms compatibility polling when the capability marker is absent', async () => {
    await withFakeTimers(async () => {
      const remote = new FakeRemote()
      remote.snapshots.push(snapshot([]), snapshot([]))
      const store = new SerialConsoleStore(remote)
      const stop = store.start()

      await advanceUntil(() => remote.requests.length === 1)
      expect(remote.requests).toHaveLength(1)
      expect(remote.waitRequests).toHaveLength(0)

      await vi.advanceTimersByTimeAsync(148)
      expect(remote.requests).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(1)
      await flushMicrotasks()
      expect(remote.requests).toHaveLength(2)
      expect(remote.waitRequests).toHaveLength(0)
      stop()
    })
  })

  it('throttles waitMs zero while keeping the wait endpoint enabled', async () => {
    await withFakeTimers(async () => {
      const remote = new FakeRemote()
      remote.snapshots.push(capableSnapshot([]))
      remote.waitSnapshots.push(capableSnapshot([]))
      const store = new SerialConsoleStore(remote, { waitMs: 0 })
      const stop = store.start()

      await advanceUntil(() => remote.requests.length === 1)
      expect(remote.waitRequests).toHaveLength(0)
      await vi.advanceTimersToNextTimerAsync()
      await flushMicrotasks()
      expect(remote.requests).toHaveLength(1)
      expect(remote.waitRequests).toHaveLength(1)
      expect(remote.waitRequests[0]?.waitMs).toBe(0)

      await vi.advanceTimersByTimeAsync(149)
      expect(remote.waitRequests).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(1)
      await flushMicrotasks()
      expect(remote.waitRequests).toHaveLength(2)
      stop()
      await flushMicrotasks()
    })
  })

  it('drains backlog with immediate snapshots before opening a waiter', async () => {
    await withFakeTimers(async () => {
      const remote = new FakeRemote()
      remote.snapshots.push(
        capableSnapshot([rx(1, 'one')], { nextSeq: 3 }),
        capableSnapshot([rx(2, 'two')], { earliestSeq: 1, nextSeq: 3 }),
      )
      const store = new SerialConsoleStore(remote)
      const stop = store.start()

      await advanceUntil(() => remote.requests.length === 2 && remote.waitRequests.length === 1)

      expect(remote.requests).toEqual([
        { afterSeq: 0, limit: 2_000 },
        { afterSeq: 1, limit: 2_000 },
      ])
      expect(remote.waitRequests).toEqual([{ afterSeq: 2, limit: 2_000, waitMs: 750 }])
      expect(store.getSnapshot().events.map(event => event.seq)).toEqual([1, 2])
      stop()
      await flushMicrotasks()
    })
  })

  it('faults only after two opaque wait failures have healthy capable snapshots', async () => {
    await withFakeTimers(async () => {
      const remote = new FakeRemote()
      remote.snapshots.push(capableSnapshot([]), capableSnapshot([]), capableSnapshot([]))
      remote.waitSnapshots.push(
        new SerialRemoteError('internal', 'opaque wait failure one'),
        new SerialRemoteError('internal', 'opaque wait failure two'),
      )
      const store = new SerialConsoleStore(remote)
      const stop = store.start()

      await advanceUntil(() => remote.waitRequests.length === 1 && store.getSnapshot().syncError !== undefined)
      expect(remote.waitRequests).toHaveLength(1)
      expect(store.getSnapshot().syncFault).toBeUndefined()
      expect(store.getSnapshot().syncError).toBe('opaque wait failure one')

      await vi.advanceTimersByTimeAsync(100)
      await advanceUntil(() => store.getSnapshot().syncFault !== undefined)
      expect(remote.waitRequests).toHaveLength(2)
      expect(store.getSnapshot().syncFault).toContain('wait-snapshot-failed')
      expect(store.getSnapshot().polling).toBe(false)
      stop()
    })
  })

  it('backs off instead of faulting when the diagnostic snapshot also fails', async () => {
    await withFakeTimers(async () => {
      const remote = new FakeRemote()
      remote.snapshots.push(
        capableSnapshot([]),
        new SerialRemoteError('internal', 'snapshot transport failure'),
      )
      remote.waitSnapshots.push(new SerialRemoteError('internal', 'opaque wait failure'))
      const store = new SerialConsoleStore(remote)
      const stop = store.start()

      await advanceUntil(() => remote.requests.length === 2 && store.getSnapshot().syncError !== undefined)

      expect(store.getSnapshot().syncFault).toBeUndefined()
      expect(store.getSnapshot().syncError).toBe('snapshot transport failure')
      expect(remote.requests).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(99)
      expect(remote.requests).toHaveLength(2)
      stop()
    })
  })

  it('applies exponential retry and resets it after a healthy snapshot', async () => {
    await withFakeTimers(async () => {
      const remote = new FakeRemote()
      remote.snapshots.push(
        new SerialRemoteError('internal', 'first failure'),
        new SerialRemoteError('internal', 'second failure'),
        capableSnapshot([]),
      )
      remote.waitSnapshots.push(new Error('temporary custom-adapter failure'))
      const store = new SerialConsoleStore(remote)
      const stop = store.start()

      await advanceUntil(() => remote.requests.length === 1 && store.getSnapshot().syncError !== undefined)
      await vi.advanceTimersByTimeAsync(100)
      await advanceUntil(() => remote.requests.length === 2)
      expect(remote.requests).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(198)
      expect(remote.requests).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(1)
      await advanceUntil(() => remote.requests.length === 3 && remote.waitRequests.length === 1)
      expect(remote.requests).toHaveLength(3)
      expect(remote.waitRequests).toHaveLength(1)

      await vi.advanceTimersByTimeAsync(99)
      expect(remote.waitRequests).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(1)
      await advanceUntil(() => remote.waitRequests.length === 2)
      expect(remote.waitRequests).toHaveLength(2)
      stop()
      await flushMicrotasks()
    })
  })

  it('aborts an active waiter on stop and never overlaps real waiters', async () => {
    await withFakeTimers(async () => {
      const remote = new FakeRemote()
      remote.snapshots.push(capableSnapshot([]))
      const store = new SerialConsoleStore(remote)
      const stop = store.start()

      await advanceUntil(() => remote.activeWaiters === 1)
      expect(remote.activeWaiters).toBe(1)
      expect(remote.maxActiveWaiters).toBe(1)

      stop()
      await flushMicrotasks()
      expect(remote.waitSignals[0]?.aborted).toBe(true)
      expect(remote.activeWaiters).toBe(0)
      expect(remote.maxActiveWaiters).toBe(1)
    })
  })

  it('does not start a replacement waiter until connect retires the old one', async () => {
    await withFakeTimers(async () => {
      const remote = new FakeRemote()
      remote.snapshots.push(capableSnapshot([]))
      const store = new SerialConsoleStore(remote)
      const stop = store.start()
      await advanceUntil(() => remote.activeWaiters === 1)
      expect(remote.activeWaiters).toBe(1)

      await store.connect({ path: 'COM_TEST', baudRate: 115_200 })
      await advanceUntil(() => remote.waitRequests.length === 2 && remote.activeWaiters === 1)

      expect(remote.waitRequests).toHaveLength(2)
      expect(remote.waitSignals[0]?.aborted).toBe(true)
      expect(remote.activeWaiters).toBe(1)
      expect(remote.maxActiveWaiters).toBe(1)
      stop()
      await flushMicrotasks()
    })
  })

  it('does not start a replacement waiter until disconnect retires the old one', async () => {
    await withFakeTimers(async () => {
      const remote = new FakeRemote()
      remote.snapshots.push(capableSnapshot([]))
      const store = new SerialConsoleStore(remote)
      const stop = store.start()
      await advanceUntil(() => remote.activeWaiters === 1)

      await store.disconnect()
      await advanceUntil(() => remote.waitRequests.length === 2 && remote.activeWaiters === 1)

      expect(remote.waitSignals[0]?.aborted).toBe(true)
      expect(remote.maxActiveWaiters).toBe(1)
      stop()
      await flushMicrotasks()
    })
  })

  it('faults immediately on a deterministic client invocation rejection', async () => {
    await withFakeTimers(async () => {
      const remote = new FakeRemote()
      remote.snapshots.push(capableSnapshot([]))
      remote.waitSnapshots.push(new SerialRemoteError(
        'client-invocation-failed',
        'client assembly is invalid',
      ))
      const store = new SerialConsoleStore(remote)
      const stop = store.start()

      await advanceUntil(() => store.getSnapshot().syncFault !== undefined)

      expect(store.getSnapshot().syncFault).toContain('client-invocation-failed')
      expect(store.getSnapshot().polling).toBe(false)
      await expect(store.sendTerminalText('x')).rejects.toThrow('disabled')
      stop()
    })
  })
})

async function withFakeTimers(run: () => Promise<void>): Promise<void> {
  vi.useFakeTimers()
  try {
    await run()
  } finally {
    vi.clearAllTimers()
    vi.useRealTimers()
  }
}

async function advanceUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await flushMicrotasks()
    if (predicate()) return
    await vi.advanceTimersByTimeAsync(1)
  }
  throw new Error('timed out while advancing the synchronization test clock')
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

async function resolveSnapshotOutcome(
  outcome: SnapshotOutcome,
  signal?: AbortSignal,
): Promise<SerialSnapshot> {
  if (outcome instanceof Error) throw outcome
  if (typeof outcome === 'function') return await outcome(signal)
  return outcome
}

function waitUntilAbort(signal?: AbortSignal): Promise<SerialSnapshot> {
  return new Promise((_resolve, reject) => {
    const rejectAbort = () => {
      reject(signal?.reason instanceof Error ? signal.reason : new Error('snapshot wait aborted'))
    }
    if (signal?.aborted === true) {
      rejectAbort()
      return
    }
    signal?.addEventListener('abort', rejectAbort, { once: true })
  })
}

function rx(seq: number, text: string): SerialEvent {
  return {
    type: 'rx', sessionId: 'session-1', seq,
    timestamp: seq, monotonicMs: seq,
    dataBase64: btoa(text), text,
  }
}

function snapshot(
  events: readonly SerialEvent[],
  override: Partial<SerialSnapshot> = {},
): SerialSnapshot {
  return {
    sessionId: 'session-1',
    status: 'connected',
    earliestSeq: events[0]?.seq ?? 1,
    nextSeq: (events.at(-1)?.seq ?? 0) + 1,
    truncated: false,
    events,
    ...override,
  }
}

function capableSnapshot(
  events: readonly SerialEvent[],
  override: Partial<SerialSnapshot> = {},
): SerialSnapshot {
  return snapshot(events, {
    capabilities: { waitSnapshot: SERIAL_WAIT_SNAPSHOT_CAPABILITY },
    ...override,
  })
}
