import { describe, expect, it } from 'vitest'
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

class FakeRemote implements SerialConsoleRemote {
  readonly requests: SerialSnapshotRequest[] = []
  readonly snapshots: SerialSnapshot[] = []
  readonly sends: SerialSendRequest[] = []
  sendError: Error | undefined
  private nextSendSeq = 1

  async listPorts(): Promise<readonly SerialPortDescriptor[]> {
    return [{ path: 'COM_TEST' }]
  }

  async connect(options: SerialOpenOptions): Promise<SerialSnapshot> {
    return snapshot([], { sessionId: 'session-1', status: 'connected', port: options })
  }

  async disconnect(): Promise<SerialSnapshot> {
    return snapshot([], { sessionId: 'session-1', status: 'disconnected' })
  }

  async snapshot(request: SerialSnapshotRequest = {}): Promise<SerialSnapshot> {
    this.requests.push(request)
    const result = this.snapshots.shift() ?? snapshot([], { nextSeq: this.nextSendSeq })
    this.nextSendSeq = Math.max(this.nextSendSeq, result.nextSeq)
    return result
  }

  async waitSnapshot(request: SerialWaitSnapshotRequest): Promise<SerialSnapshot> {
    return await this.snapshot(request)
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
})

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
