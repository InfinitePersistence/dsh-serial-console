import { randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { SERIAL_WAIT_SNAPSHOT_CAPABILITY } from '../protocol.js'
import type {
  SerialActor,
  SerialConnectionStatus,
  SerialErrorEvent,
  SerialEvent,
  SerialExpectRequest,
  SerialExpectResult,
  SerialMarkerEvent,
  SerialOpenOptions,
  SerialSendResult,
  SerialSnapshot,
  SerialWaitSnapshotRequest,
} from '../protocol.js'
import { SequenceRing } from './ring-buffer.js'
import type {
  Dispose,
  SerialEventSink,
  SerialTransport,
  SerialTransportFactory,
} from './transport.js'

export interface SerialSessionManagerOptions {
  readonly ringCapacity?: number
  readonly snapshotLimit?: number
  readonly eventSink?: SerialEventSink
  readonly now?: () => number
  readonly monotonicNow?: () => number
  readonly createSessionId?: () => string
}

export interface SerialWriteMetadata {
  readonly actor: SerialActor
  readonly text?: string
  readonly toolCallId?: string
}

type SerialEventBody = SerialEvent extends infer Event
  ? Event extends SerialEvent
    ? Omit<Event, 'sessionId' | 'seq' | 'timestamp' | 'monotonicMs'>
    : never
  : never

export class SerialExpectTimeoutError extends Error {
  constructor(readonly timeoutMs: number, readonly pattern: string) {
    super(`serial expect timed out after ${timeoutMs} ms: /${pattern}/`)
    this.name = 'SerialExpectTimeoutError'
  }
}

export class SerialSessionManagerClosedError extends Error {
  constructor() {
    super('serial session manager closed while waiting for a snapshot')
    this.name = 'SerialSessionManagerClosedError'
  }
}

export const DEFAULT_SERIAL_SNAPSHOT_WAIT_MS = 750
export const MAX_SERIAL_SNAPSHOT_WAIT_MS = 1_000

/**
 * Single owner of one physical port. Every model and user write enters the same
 * queue, and every RX/TX/state transition receives one Host sequence number.
 */
export class SerialSessionManager {
  private readonly events: SequenceRing<SerialEvent>
  private readonly listeners = new Set<(event: SerialEvent) => void>()
  private readonly snapshotWaitClosers = new Set<(error: Error) => void>()
  private readonly snapshotLimit: number
  private readonly sink: SerialEventSink | undefined
  private readonly now: () => number
  private readonly monotonicNow: () => number
  private readonly createSessionId: () => string
  private status: SerialConnectionStatus = 'disconnected'
  private port: SerialOpenOptions | undefined
  private sessionId: string | undefined
  private nextSeq = 1
  private transport: SerialTransport | undefined
  private transportDisposers: Dispose[] = []
  private decoder = new TextDecoder('utf-8', { fatal: false })
  private writeTail: Promise<void> = Promise.resolve()
  private intentionalClose = false
  private closed = false

  constructor(
    private readonly factory: SerialTransportFactory,
    options: SerialSessionManagerOptions = {},
  ) {
    const capacity = options.ringCapacity ?? 20_000
    this.events = new SequenceRing(capacity)
    this.snapshotLimit = options.snapshotLimit ?? 2_000
    if (!Number.isSafeInteger(this.snapshotLimit) || this.snapshotLimit < 1) {
      throw new TypeError('snapshotLimit must be a positive safe integer')
    }
    this.sink = options.eventSink
    this.now = options.now ?? Date.now
    this.monotonicNow = options.monotonicNow ?? (() => performance.now())
    this.createSessionId = options.createSessionId ?? randomUUID
  }

  async listPorts() {
    return await this.factory.list()
  }

  /** Open a new physical lifecycle, closing the previous one first if needed. */
  async connect(options: SerialOpenOptions): Promise<SerialSnapshot> {
    validateOpenOptions(options)
    if (this.status !== 'disconnected' && this.status !== 'error') await this.disconnect()
    this.detachTransport()
    this.events.clear()
    this.sessionId = this.createSessionId()
    this.port = { ...options }
    this.decoder = new TextDecoder('utf-8', { fatal: false })
    this.intentionalClose = false
    this.setState('opening')

    const transport = this.factory.create()
    this.transport = transport
    this.transportDisposers = [
      transport.onData(data => { this.receive(data) }),
      transport.onError(error => { this.reportError('SERIAL_TRANSPORT_ERROR', error) }),
      transport.onClose(() => { this.onTransportClosed() }),
    ]

    try {
      await transport.open(options)
      if (this.transport !== transport) {
        await transport.close().catch(() => undefined)
        throw new Error('serial connection was superseded while opening')
      }
      this.setState('connected')
      return this.snapshot()
    } catch (error) {
      this.reportError('SERIAL_OPEN_FAILED', toError(error))
      this.status = 'error'
      this.publishState('error', toError(error).message)
      this.detachTransport()
      throw error
    }
  }

  /** Drain accepted writes, close the transport, and preserve the event log. */
  async disconnect(): Promise<SerialSnapshot> {
    const transport = this.transport
    if (transport === undefined) {
      if (this.status !== 'disconnected') this.setState('disconnected')
      return this.snapshot()
    }
    this.intentionalClose = true
    this.setState('closing')
    await this.writeTail
    try {
      await transport.close()
      this.detachTransport()
      this.setState('disconnected')
    } catch (error) {
      this.reportError('SERIAL_CLOSE_FAILED', toError(error))
      this.detachTransport()
      this.status = 'error'
      this.publishState('error', toError(error).message)
      throw error
    } finally {
      this.intentionalClose = false
    }
    return this.snapshot()
  }

  /** Serialize one write with every other model and user write. */
  send(data: Uint8Array, metadata: SerialWriteMetadata): Promise<SerialSendResult> {
    if (data.byteLength === 0) throw new TypeError('serial write must contain at least one byte')
    const bytes = Uint8Array.from(data)
    const operation = this.writeTail.then(async () => {
      const transport = this.transport
      if (transport === undefined || this.status !== 'connected' || this.sessionId === undefined) {
        throw new Error('serial port is not connected')
      }
      await transport.write(bytes)
      const event = this.publish({
        type: 'tx',
        actor: metadata.actor,
        dataBase64: Buffer.from(bytes).toString('base64'),
        ...(metadata.text === undefined ? {} : { text: metadata.text }),
        ...(metadata.toolCallId === undefined ? {} : { toolCallId: metadata.toolCallId }),
      })
      return { sessionId: event.sessionId, seq: event.seq, byteLength: bytes.byteLength }
    })
    this.writeTail = operation.then(() => undefined, () => undefined)
    return operation
  }

  mark(label: string, actor: SerialActor, toolCallId?: string): SerialMarkerEvent {
    const normalized = label.trim()
    if (normalized.length === 0) throw new TypeError('serial marker label must not be blank')
    return this.publish({
      type: 'marker',
      actor,
      label: normalized,
      ...(toolCallId === undefined ? {} : { toolCallId }),
    })
  }

  snapshot(afterSeq = 0, limit = this.snapshotLimit): SerialSnapshot {
    const boundedLimit = Math.min(limit, this.events.capacity)
    const slice = this.events.after(afterSeq, boundedLimit)
    return {
      ...(this.sessionId === undefined ? {} : { sessionId: this.sessionId }),
      status: this.status,
      ...(this.port === undefined ? {} : { port: { ...this.port } }),
      capabilities: { waitSnapshot: SERIAL_WAIT_SNAPSHOT_CAPABILITY },
      earliestSeq: this.events.earliestSeq ?? this.nextSeq,
      nextSeq: this.nextSeq,
      truncated: slice.truncated,
      events: slice.items,
    }
  }

  /** Wait for the next event without losing an event published while subscribing. */
  waitSnapshot(
    request: SerialWaitSnapshotRequest = {},
    signal?: AbortSignal,
  ): Promise<SerialSnapshot> {
    if (this.closed) return Promise.reject(new SerialSessionManagerClosedError())
    if (signal?.aborted === true) return Promise.reject(abortReason(signal))
    const waitMs = request.waitMs ?? DEFAULT_SERIAL_SNAPSHOT_WAIT_MS
    if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > MAX_SERIAL_SNAPSHOT_WAIT_MS) {
      throw new TypeError(`waitMs must be a safe integer between 0 and ${MAX_SERIAL_SNAPSHOT_WAIT_MS}`)
    }
    const takeSnapshot = () => this.snapshot(
      request.afterSeq ?? 0,
      request.limit ?? this.snapshotLimit,
    )
    const initial = takeSnapshot()
    if (waitMs === 0 || snapshotHasChanges(initial)) return Promise.resolve(initial)

    return new Promise((resolve, reject) => {
      let settled = false
      let dispose: Dispose = () => undefined
      let timer: ReturnType<typeof setTimeout> | undefined

      const cleanup = () => {
        dispose()
        if (timer !== undefined) clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        this.snapshotWaitClosers.delete(onClose)
      }
      const settle = (action: () => void) => {
        if (settled) return
        settled = true
        cleanup()
        action()
      }
      const resolveLatest = () => {
        try {
          const latest = takeSnapshot()
          settle(() => { resolve(latest) })
        } catch (error) {
          settle(() => { reject(error) })
        }
      }
      const rejectWith = (error: Error) => { settle(() => { reject(error) }) }
      const onAbort = () => { rejectWith(abortReason(signal as AbortSignal)) }
      const onClose = (error: Error) => { rejectWith(error) }

      dispose = this.subscribe(resolveLatest)
      this.snapshotWaitClosers.add(onClose)
      signal?.addEventListener('abort', onAbort, { once: true })

      try {
        const second = takeSnapshot()
        if (snapshotHasChanges(second)) {
          settle(() => { resolve(second) })
          return
        }
        timer = setTimeout(resolveLatest, waitMs)
      } catch (error) {
        settle(() => { reject(error) })
      }
    })
  }

  subscribe(listener: (event: SerialEvent) => void): Dispose {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Wait for an RX-only regular-expression match without feeding unrelated logs to the model. */
  waitForText(request: SerialExpectRequest, signal?: AbortSignal): Promise<SerialExpectResult> {
    const timeoutMs = request.timeoutMs ?? 30_000
    const maxChars = request.maxChars ?? 65_536
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new TypeError('timeoutMs must be a positive safe integer')
    }
    if (!Number.isSafeInteger(maxChars) || maxChars < 1) {
      throw new TypeError('maxChars must be a positive safe integer')
    }
    const flags = request.flags ?? 'm'
    const expression = new RegExp(request.pattern, flags)
    const initial = this.snapshot(request.afterSeq ?? 0, this.events.capacity).events
      .filter((event): event is Extract<SerialEvent, { type: 'rx' }> => event.type === 'rx')

    return new Promise((resolve, reject) => {
      let text = ''
      let startSeq = initial[0]?.seq ?? this.nextSeq
      let endSeq = request.afterSeq ?? 0
      let settled = false
      let dispose: Dispose = () => undefined
      let timer: ReturnType<typeof setTimeout> | undefined

      const cleanup = () => {
        dispose()
        if (timer !== undefined) clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }
      const fail = (error: Error) => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }
      const check = () => {
        expression.lastIndex = 0
        const match = expression.exec(text)
        if (match === null || this.sessionId === undefined || settled) return
        settled = true
        cleanup()
        resolve({
          sessionId: this.sessionId,
          startSeq,
          endSeq,
          match: match[0],
          index: match.index,
        })
      }
      const append = (event: Extract<SerialEvent, { type: 'rx' }>) => {
        if (event.text === undefined) return
        if (text.length === 0) startSeq = event.seq
        text += event.text
        endSeq = event.seq
        if (text.length > maxChars) text = text.slice(text.length - maxChars)
        check()
      }
      const onAbort = () => { fail(signal?.reason instanceof Error ? signal.reason : new Error('serial expect aborted')) }

      for (const event of initial) append(event)
      if (settled) return
      dispose = this.subscribe((event) => {
        if (event.type === 'rx') append(event)
        if (event.type === 'state' && (event.status === 'disconnected' || event.status === 'error')) {
          fail(new Error(`serial connection became ${event.status} while waiting for /${request.pattern}/`))
        }
      })
      timer = setTimeout(() => { fail(new SerialExpectTimeoutError(timeoutMs, request.pattern)) }, timeoutMs)
      if (signal?.aborted === true) onAbort()
      else signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const closeError = new SerialSessionManagerClosedError()
    for (const closeWaiter of [...this.snapshotWaitClosers]) closeWaiter(closeError)
    if (this.transport !== undefined) await this.disconnect().catch(() => undefined)
    await this.sink?.flush?.()
    await this.sink?.close?.()
    this.listeners.clear()
  }

  private receive(data: Uint8Array): void {
    if (data.byteLength === 0 || this.sessionId === undefined) return
    const bytes = Uint8Array.from(data)
    const text = this.decoder.decode(bytes, { stream: true })
    this.publish({
      type: 'rx',
      dataBase64: Buffer.from(bytes).toString('base64'),
      ...(text.length === 0 ? {} : { text }),
    })
  }

  private onTransportClosed(): void {
    if (this.intentionalClose || this.transport === undefined) return
    this.detachTransport()
    this.setState('disconnected', 'serial transport closed')
  }

  private setState(status: SerialConnectionStatus, message?: string): void {
    this.status = status
    this.publishState(status, message)
  }

  private publishState(status: SerialConnectionStatus, message?: string): void {
    if (this.sessionId === undefined) return
    this.publish({
      type: 'state',
      status,
      ...(this.port === undefined ? {} : { port: { ...this.port } }),
      ...(message === undefined ? {} : { message }),
    })
  }

  private reportError(code: string, error: Error): SerialErrorEvent | undefined {
    if (this.sessionId === undefined) return undefined
    return this.publish({ type: 'error', code, message: error.message })
  }

  private publish<T extends SerialEventBody>(
    body: T,
  ): Extract<SerialEvent, { type: T['type'] }> {
    if (this.sessionId === undefined) throw new Error('cannot publish a serial event without a session')
    const event = {
      ...body,
      sessionId: this.sessionId,
      seq: this.nextSeq++,
      timestamp: this.now(),
      monotonicMs: this.monotonicNow(),
    } as unknown as Extract<SerialEvent, { type: T['type'] }>
    this.events.push(event)
    this.sink?.write(event)
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch {
        // A browser or tool observer is not allowed to interrupt serial capture.
      }
    }
    return event
  }

  private detachTransport(): void {
    for (const dispose of this.transportDisposers.splice(0)) dispose()
    this.transport = undefined
  }
}

function snapshotHasChanges(snapshot: SerialSnapshot): boolean {
  return snapshot.truncated || snapshot.events.length > 0
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  const error = new Error('serial snapshot wait aborted')
  error.name = 'AbortError'
  return error
}

function validateOpenOptions(options: SerialOpenOptions): void {
  if (options.path.trim().length === 0) throw new TypeError('serial path must not be blank')
  if (!Number.isSafeInteger(options.baudRate) || options.baudRate < 1) {
    throw new TypeError('baudRate must be a positive safe integer')
  }
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}
