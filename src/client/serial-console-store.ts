import {
  SERIAL_WAIT_SNAPSHOT_CAPABILITY,
  SerialRemoteError,
} from '../protocol.js'
import type {
  SerialConsoleRemote,
  SerialEvent,
  SerialOpenOptions,
  SerialPortDescriptor,
  SerialSendRequest,
  SerialSnapshot,
} from '../protocol.js'

/** Line-ending bytes selected for a physical Enter key press. */
export type SerialLineEnding = NonNullable<SerialSendRequest['lineEnding']>

/** Immutable browser projection of the Host-owned serial session. */
export interface SerialConsoleViewState {
  readonly remote: SerialSnapshot
  readonly ports: readonly SerialPortDescriptor[]
  readonly events: readonly SerialEvent[]
  readonly selectedPath: string
  readonly baudRate: string
  readonly lineEnding: SerialLineEnding
  readonly loadingPorts: boolean
  readonly polling: boolean
  readonly gapDetected: boolean
  readonly lastError: string | undefined
  readonly syncError: string | undefined
  readonly syncFault: string | undefined
}

/** Synchronization and retention settings for one browser-side serial console. */
export interface SerialConsoleStoreOptions {
  readonly initialBaudRate?: number
  readonly pollIntervalMs?: number
  readonly waitMs?: number
  readonly pollLimit?: number
  readonly maxClientEvents?: number
  readonly snapshotTimeoutMs?: number
}

const EMPTY_REMOTE: SerialSnapshot = {
  status: 'disconnected',
  earliestSeq: 1,
  nextSeq: 1,
  truncated: false,
  events: [],
}

const SNAPSHOT_TIMEOUT_MESSAGE = 'Serial synchronization timed out; retrying.'
const DEFAULT_WAIT_MS = 750
const MAX_WAIT_MS = 1_000
const DEFAULT_SNAPSHOT_TIMEOUT_MS = 1_500
const MIN_RETRY_DELAY_MS = 100
const MAX_RETRY_DELAY_MS = 500
const OPAQUE_WAIT_FAILURE_LIMIT = 2

type WaitCapability = 'unknown' | 'supported' | 'unsupported'
type RefreshAbortReason = 'timeout' | 'connect' | 'disconnect' | 'stop'

const WAIT_UNAVAILABLE_CODES = new Set(['invocation-unavailable', 'method-unavailable'])
const FATAL_SYNCHRONIZATION_CODES = new Set([
  'arguments-invalid',
  'input-invalid',
  'signature-invalid',
  'result-invalid',
  'ambiguous-endpoint',
  'provider-mismatch',
  'client-invocation-failed',
])

class SerialRefreshAbortError extends Error {
  constructor(readonly reason: RefreshAbortReason) {
    super(`serial snapshot refresh aborted: ${reason}`)
    this.name = 'SerialRefreshAbortError'
  }
}

/**
 * Browser-side synchronization store. Physical writes are serialized in one FIFO;
 * xterm owns terminal editing and the Host remains authoritative for events.
 * Empty unchanged polls preserve the published snapshot reference.
 */
export class SerialConsoleStore {
  private readonly listeners = new Set<() => void>()
  private readonly pollIntervalMs: number
  private readonly waitMs: number
  private readonly pollLimit: number
  private readonly maxClientEvents: number
  private readonly snapshotTimeoutMs: number
  private state: SerialConsoleViewState = {
    remote: EMPTY_REMOTE,
    ports: [],
    events: [],
    selectedPath: '',
    baudRate: '115200',
    lineEnding: 'cr',
    loadingPorts: false,
    polling: false,
    gapDetected: false,
    lastError: undefined,
    syncError: undefined,
    syncFault: undefined,
  }
  private running = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private refreshInFlight: Promise<void> | undefined
  private refreshController: AbortController | undefined
  private refreshEpoch = 0
  private syncSuspensions = 0
  private waitCapability: WaitCapability = 'unknown'
  private opaqueWaitFailureConfirmations = 0
  private drainingBacklog = false
  private retryDelayMs = MIN_RETRY_DELAY_MS
  private nextRefreshDelayMs = 0
  private writeTail: Promise<void> = Promise.resolve()

  constructor(private readonly remote: SerialConsoleRemote, options: SerialConsoleStoreOptions = {}) {
    this.state = {
      ...this.state,
      baudRate: String(positiveInteger(options.initialBaudRate ?? 115_200, 'initialBaudRate')),
    }
    this.pollIntervalMs = positiveInteger(options.pollIntervalMs ?? 150, 'pollIntervalMs')
    this.waitMs = nonNegativeInteger(options.waitMs ?? DEFAULT_WAIT_MS, 'waitMs')
    if (this.waitMs > MAX_WAIT_MS) throw new TypeError(`waitMs must not exceed ${MAX_WAIT_MS}`)
    this.pollLimit = positiveInteger(options.pollLimit ?? 2_000, 'pollLimit')
    this.maxClientEvents = positiveInteger(options.maxClientEvents ?? 10_000, 'maxClientEvents')
    this.snapshotTimeoutMs = positiveInteger(
      options.snapshotTimeoutMs ?? DEFAULT_SNAPSHOT_TIMEOUT_MS,
      'snapshotTimeoutMs',
    )
    if (this.snapshotTimeoutMs <= this.waitMs) {
      throw new TypeError('snapshotTimeoutMs must be greater than waitMs')
    }
  }

  getSnapshot = (): SerialConsoleViewState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Retain the selected device path across component remounts. */
  setSelectedPath(selectedPath: string): void {
    this.patch({ selectedPath })
  }

  /** Retain editable baud-rate text across component remounts. */
  setBaudRate(baudRate: string): void {
    this.patch({ baudRate })
  }

  /** Retain the physical Enter-key line ending across component remounts. */
  setLineEnding(lineEnding: SerialLineEnding): void {
    this.patch({ lineEnding })
  }

  /** Start continuous snapshot synchronization and return its idempotent disposer. */
  start(): () => void {
    if (!this.running) {
      this.running = true
      this.patch({ polling: this.state.syncFault === undefined })
      const retired = this.refreshInFlight
      const epoch = this.refreshEpoch
      if (retired === undefined) {
        this.schedule(0)
      } else {
        const resume = () => {
          if (epoch === this.refreshEpoch) this.schedule(0)
        }
        void retired.then(resume, resume)
      }
    }
    return () => { this.stop() }
  }

  /** Stop synchronization, abort the carrier, and fence any late response. */
  stop(): void {
    this.running = false
    this.retireRefresh('stop')
    this.patch({ polling: false })
  }

  /** Refresh the selectable physical-port list. */
  async loadPorts(): Promise<void> {
    this.patch({ loadingPorts: true, lastError: undefined })
    try {
      const ports = await this.remote.listPorts()
      const selectedPath = this.state.selectedPath === ''
        ? ports[0]?.path ?? ''
        : this.state.selectedPath
      this.patch({ ports, selectedPath, loadingPorts: false })
    } catch (error) {
      this.patch({ loadingPorts: false, lastError: errorMessage(error) })
    }
  }

  /** Open a physical port and replace the local event window with its session. */
  async connect(options: SerialOpenOptions): Promise<void> {
    this.assertSynchronizationWritable('connect')
    const retired = this.suspendSynchronization('connect')
    const epoch = this.refreshEpoch
    this.patch({
      selectedPath: options.path,
      baudRate: String(options.baudRate),
      lastError: undefined,
    })
    try {
      const remote = await this.remote.connect(options)
      if (epoch !== this.refreshEpoch) return
      this.applyRemote(remote, true)
    } catch (error) {
      if (epoch === this.refreshEpoch) this.patch({ lastError: errorMessage(error) })
      throw error
    } finally {
      this.resumeSynchronization(retired)
    }
  }

  /** Close the active physical port while retaining the user's connection choices. */
  async disconnect(): Promise<void> {
    const retired = this.suspendSynchronization('disconnect')
    const epoch = this.refreshEpoch
    this.patch({ lastError: undefined })
    try {
      const remote = await this.remote.disconnect()
      if (epoch !== this.refreshEpoch) return
      this.applyRemote(remote, false)
    } catch (error) {
      if (epoch === this.refreshEpoch) this.patch({ lastError: errorMessage(error) })
      throw error
    } finally {
      this.resumeSynchronization(retired)
    }
  }

  /**
   * Send xterm text exactly as produced by its input stream. Enter conversion
   * is performed by the terminal adapter before this method is called.
   */
  async sendTerminalText(text: string): Promise<void> {
    if (text.length === 0) return
    await this.send({ actor: 'user', text, lineEnding: 'none' })
  }

  /** Send xterm's binary mouse/report stream without UTF-8 re-encoding. */
  async sendTerminalBinary(dataBase64: string): Promise<void> {
    if (dataBase64.length === 0) return
    await this.send({ actor: 'user', dataBase64, lineEnding: 'none' })
  }

  /** Serialize one user/model request behind all earlier browser writes. */
  async send(request: SerialSendRequest): Promise<void> {
    this.assertSynchronizationWritable('send')
    try {
      await this.enqueueSend(request)
      if (this.state.lastError !== undefined) this.patch({ lastError: undefined })
    } catch (error) {
      this.patch({ lastError: errorMessage(error) })
      throw error
    }
  }

  /** Pull one immediate read-only snapshot through the single-flight gate. */
  async refresh(): Promise<void> {
    await (this.refreshInFlight ?? this.beginRefresh(true, true))
  }

  private beginRefresh(forceSnapshot: boolean, manual: boolean): Promise<void> {
    if (this.refreshInFlight !== undefined) return this.refreshInFlight
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    const epoch = this.refreshEpoch
    const controller = new AbortController()
    const operation = this.refreshOnce(epoch, controller, forceSnapshot, manual)
    this.refreshInFlight = operation
    this.refreshController = controller
    const finish = () => {
      if (this.refreshInFlight === operation) {
        this.refreshInFlight = undefined
        this.refreshController = undefined
      }
      if (epoch === this.refreshEpoch) this.schedule(this.nextRefreshDelayMs)
    }
    void operation.then(finish, finish)
    return operation
  }

  private async refreshOnce(
    epoch: number,
    controller: AbortController,
    forceSnapshot: boolean,
    manual: boolean,
  ): Promise<void> {
    if (!manual && this.state.syncFault !== undefined) return
    const afterSeq = this.state.events.at(-1)?.seq ?? 0
    const request = { afterSeq, limit: this.pollLimit }
    const useImmediateSnapshot = forceSnapshot
      || this.drainingBacklog
      || this.waitCapability !== 'supported'
    let confirmingWaitFailure = false

    try {
      if (useImmediateSnapshot) {
        const remote = await this.withSnapshotTimeout(
          signal => this.remote.snapshot(request, signal),
          controller,
        )
        if (epoch !== this.refreshEpoch) return
        this.acceptSnapshot(remote, manual)
        return
      }

      let waitFailure: unknown
      try {
        const remote = await this.withSnapshotTimeout(
          signal => this.remote.waitSnapshot({ ...request, waitMs: this.waitMs }, signal),
          controller,
        )
        if (epoch !== this.refreshEpoch) return
        this.opaqueWaitFailureConfirmations = 0
        this.acceptSnapshot(remote, manual)
        return
      } catch (error) {
        if (epoch !== this.refreshEpoch || lifecycleAbort(controller.signal)) return
        if (!shouldConfirmWaitFailure(error)) {
          this.opaqueWaitFailureConfirmations = 0
          throw error
        }
        waitFailure = error
      }

      confirmingWaitFailure = true
      const remote = await this.withSnapshotTimeout(
        signal => this.remote.snapshot(request, signal),
        controller,
      )
      if (epoch !== this.refreshEpoch) return
      this.acceptSnapshot(remote, manual)
      if (this.waitCapability === 'unsupported') {
        this.opaqueWaitFailureConfirmations = 0
        return
      }
      if (isWaitUnavailable(waitFailure)) {
        this.tripSynchronizationFault(waitFailure)
        return
      }

      this.opaqueWaitFailureConfirmations += 1
      if (this.opaqueWaitFailureConfirmations >= OPAQUE_WAIT_FAILURE_LIMIT) {
        this.tripSynchronizationFault(new SerialRemoteError(
          'wait-snapshot-failed',
          'waitSnapshot failed repeatedly while ordinary snapshots remained available',
        ))
        return
      }
      this.recordTransientSynchronizationError(
        errorMessage(waitFailure),
        this.drainingBacklog,
      )
    } catch (error) {
      if (epoch !== this.refreshEpoch || lifecycleAbort(controller.signal)) return
      if (confirmingWaitFailure) this.opaqueWaitFailureConfirmations = 0
      if (controller.signal.reason instanceof SerialRefreshAbortError
        && controller.signal.reason.reason === 'timeout') {
        this.recordTransientSynchronizationError(SNAPSHOT_TIMEOUT_MESSAGE)
        return
      }
      if (isFatalSynchronizationError(error)
        || ((useImmediateSnapshot || confirmingWaitFailure) && isWaitUnavailable(error))) {
        this.tripSynchronizationFault(error)
        return
      }
      this.recordTransientSynchronizationError(errorMessage(error))
    }
  }

  private async withSnapshotTimeout(
    operation: (signal: AbortSignal) => Promise<SerialSnapshot>,
    controller: AbortController,
  ): Promise<SerialSnapshot> {
    const timer = setTimeout(() => {
      controller.abort(new SerialRefreshAbortError('timeout'))
    }, this.snapshotTimeoutMs)
    try {
      const snapshot = await operation(controller.signal)
      if (controller.signal.aborted) throw abortError(controller.signal)
      return snapshot
    } finally {
      clearTimeout(timer)
    }
  }

  /** Abort one snapshot generation without forgetting its unsettled Promise. */
  private retireRefresh(reason: RefreshAbortReason): Promise<void> {
    this.refreshEpoch += 1
    this.opaqueWaitFailureConfirmations = 0
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    const operation = this.refreshInFlight ?? Promise.resolve()
    if (this.refreshController?.signal.aborted === false) {
      this.refreshController.abort(new SerialRefreshAbortError(reason))
    }
    return operation
  }

  private suspendSynchronization(reason: 'connect' | 'disconnect'): Promise<void> {
    this.syncSuspensions += 1
    return this.retireRefresh(reason)
  }

  private resumeSynchronization(retired: Promise<void>): void {
    this.syncSuspensions -= 1
    const schedule = () => {
      if (this.syncSuspensions === 0) this.schedule(0)
    }
    void retired.then(schedule, schedule)
  }

  private acceptSnapshot(remote: SerialSnapshot, manual: boolean): void {
    this.observeWaitCapability(remote)
    this.applyRemote(remote, false)
    this.drainingBacklog = remote.truncated || snapshotHasBacklog(remote)
    this.retryDelayMs = MIN_RETRY_DELAY_MS
    this.nextRefreshDelayMs = this.drainingBacklog
      ? 0
      : this.waitCapability === 'unsupported' || this.waitMs === 0
        ? this.pollIntervalMs
        : 0
    if (this.state.syncError !== undefined) this.patch({ syncError: undefined })
    if (manual && this.state.syncFault !== undefined) this.nextRefreshDelayMs = 0
  }

  private observeWaitCapability(remote: SerialSnapshot): void {
    if (this.waitCapability === 'unsupported') return
    if (hasWaitSnapshotCapability(remote)) {
      this.waitCapability = 'supported'
      return
    }
    this.waitCapability = 'unsupported'
    this.opaqueWaitFailureConfirmations = 0
  }

  private recordTransientSynchronizationError(message: string, keepCurrentDelay = false): void {
    if (!keepCurrentDelay) {
      this.nextRefreshDelayMs = this.retryDelayMs
      this.retryDelayMs = Math.min(this.retryDelayMs * 2, MAX_RETRY_DELAY_MS)
    }
    if (this.state.syncError !== message) this.patch({ syncError: message })
  }

  private tripSynchronizationFault(error: unknown): void {
    const message = error instanceof SerialRemoteError
      ? `Serial synchronization stopped (${error.code}): ${error.message}`
      : `Serial synchronization stopped: ${errorMessage(error)}`
    this.nextRefreshDelayMs = 0
    this.patch({ polling: false, syncError: undefined, syncFault: message })
  }

  private assertSynchronizationWritable(operation: 'connect' | 'send'): void {
    if (this.state.syncFault === undefined) return
    throw new Error(`serial ${operation} is disabled while synchronization is stopped`)
  }

  private applyRemote(remote: SerialSnapshot, forceReset: boolean): void {
    const current = this.state
    const changedSession = remote.sessionId !== current.remote.sessionId
    const replaceWindow = forceReset || changedSession || remote.truncated
    const merged = replaceWindow
      ? [...remote.events]
      : appendUnique(current.events, remote.events)
    const events = merged.length > this.maxClientEvents
      ? merged.slice(merged.length - this.maxClientEvents)
      : merged
    const remoteSelection = remote.status === 'connected' ? remote.port : undefined
    const selectedPath = remoteSelection?.path ?? current.selectedPath
    const baudRate = remoteSelection === undefined
      ? current.baudRate
      : String(remoteSelection.baudRate)
    const gapDetected = current.gapDetected || remote.truncated
    const lastError = remote.status === 'error'
      ? remote.events.findLast(event => event.type === 'error')?.message ?? current.lastError
      : current.lastError
    if (!forceReset
      && events === current.events
      && sameSnapshotMetadata(current.remote, remote)
      && selectedPath === current.selectedPath
      && baudRate === current.baudRate
      && gapDetected === current.gapDetected
      && lastError === current.lastError) return
    this.replace({
      ...current,
      remote,
      events,
      selectedPath,
      baudRate,
      gapDetected,
      lastError,
    })
  }

  private enqueueSend(request: SerialSendRequest): ReturnType<SerialConsoleRemote['send']> {
    const operation = this.writeTail.then(async () => await this.remote.send(request))
    this.writeTail = operation.then(() => undefined, () => undefined)
    return operation
  }

  private schedule(delayMs: number): void {
    if (!this.running
      || this.state.syncFault !== undefined
      || this.syncSuspensions !== 0
      || this.timer !== undefined
      || this.refreshInFlight !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.beginRefresh(false, false)
    }, delayMs)
  }

  private patch(update: Partial<SerialConsoleViewState>): void {
    this.replace({ ...this.state, ...update })
  }

  private replace(next: SerialConsoleViewState): void {
    this.state = next
    for (const listener of [...this.listeners]) listener()
  }
}

function appendUnique(
  existing: readonly SerialEvent[],
  incoming: readonly SerialEvent[],
): readonly SerialEvent[] {
  if (incoming.length === 0) return existing
  const lastSeq = existing.at(-1)?.seq ?? 0
  const appended = incoming.filter(event => event.seq > lastSeq)
  return appended.length === 0 ? existing : [...existing, ...appended]
}

function sameSnapshotMetadata(left: SerialSnapshot, right: SerialSnapshot): boolean {
  return left.sessionId === right.sessionId
    && left.status === right.status
    && sameOpenOptions(left.port, right.port)
    && left.capabilities?.waitSnapshot === right.capabilities?.waitSnapshot
    && left.earliestSeq === right.earliestSeq
    && left.nextSeq === right.nextSeq
    && left.truncated === right.truncated
}

function sameOpenOptions(left: SerialOpenOptions | undefined, right: SerialOpenOptions | undefined): boolean {
  if (left === right) return true
  if (left === undefined || right === undefined) return false
  return left.path === right.path
    && left.baudRate === right.baudRate
    && left.dataBits === right.dataBits
    && left.stopBits === right.stopBits
    && left.parity === right.parity
    && left.rtscts === right.rtscts
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`)
  }
  return value
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`)
  }
  return value
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function snapshotHasBacklog(snapshot: SerialSnapshot): boolean {
  const lastSeq = snapshot.events.at(-1)?.seq
  return lastSeq !== undefined && lastSeq < snapshot.nextSeq - 1
}

function hasWaitSnapshotCapability(snapshot: SerialSnapshot): boolean {
  return snapshot.capabilities?.waitSnapshot === SERIAL_WAIT_SNAPSHOT_CAPABILITY
}

function isWaitUnavailable(error: unknown): boolean {
  return error instanceof SerialRemoteError && WAIT_UNAVAILABLE_CODES.has(error.code)
}

function isOpaqueGatewayError(error: unknown): boolean {
  return error instanceof SerialRemoteError && error.code === 'internal'
}

function shouldConfirmWaitFailure(error: unknown): boolean {
  return isWaitUnavailable(error) || isOpaqueGatewayError(error)
}

function isFatalSynchronizationError(error: unknown): boolean {
  return error instanceof SerialRemoteError && FATAL_SYNCHRONIZATION_CODES.has(error.code)
}

function lifecycleAbort(signal: AbortSignal): boolean {
  return signal.reason instanceof SerialRefreshAbortError
    && signal.reason.reason !== 'timeout'
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  const error = new Error('serial snapshot request aborted')
  error.name = 'AbortError'
  return error
}
