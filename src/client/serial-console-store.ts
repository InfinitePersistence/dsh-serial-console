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
}

/** Polling and retention settings for one browser-side serial console. */
export interface SerialConsoleStoreOptions {
  readonly initialBaudRate?: number
  readonly pollIntervalMs?: number
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

const SNAPSHOT_TIMEOUT_MESSAGE = 'Serial snapshot timed out; polling will retry.'

/**
 * Browser-side polling store. Physical writes are serialized in one FIFO;
 * xterm owns terminal editing and the Host remains authoritative for events.
 */
export class SerialConsoleStore {
  private readonly listeners = new Set<() => void>()
  private readonly pollIntervalMs: number
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
  }
  private running = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private refreshInFlight: Promise<void> | undefined
  private refreshEpoch = 0
  private writeTail: Promise<void> = Promise.resolve()

  constructor(private readonly remote: SerialConsoleRemote, options: SerialConsoleStoreOptions = {}) {
    this.state = {
      ...this.state,
      baudRate: String(positiveInteger(options.initialBaudRate ?? 115_200, 'initialBaudRate')),
    }
    this.pollIntervalMs = positiveInteger(options.pollIntervalMs ?? 150, 'pollIntervalMs')
    this.pollLimit = positiveInteger(options.pollLimit ?? 2_000, 'pollLimit')
    this.maxClientEvents = positiveInteger(options.maxClientEvents ?? 10_000, 'maxClientEvents')
    this.snapshotTimeoutMs = positiveInteger(
      options.snapshotTimeoutMs ?? Math.max(1_000, this.pollIntervalMs * 4),
      'snapshotTimeoutMs',
    )
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

  /** Start snapshot polling and return its idempotent disposer. */
  start(): () => void {
    if (!this.running) {
      this.running = true
      this.patch({ polling: true })
      void this.refreshWithinTimeout().finally(() => { this.schedule() })
    }
    return () => { this.stop() }
  }

  /** Stop polling and fence any late snapshot response. */
  stop(): void {
    this.running = false
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.retireRefresh()
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
    this.retireRefresh()
    this.patch({
      selectedPath: options.path,
      baudRate: String(options.baudRate),
      lastError: undefined,
    })
    try {
      const remote = await this.remote.connect(options)
      this.retireRefresh()
      this.applyRemote(remote, true)
    } catch (error) {
      this.retireRefresh()
      this.patch({ lastError: errorMessage(error) })
      throw error
    }
  }

  /** Close the active physical port while retaining the user's connection choices. */
  async disconnect(): Promise<void> {
    this.retireRefresh()
    this.patch({ lastError: undefined })
    try {
      const remote = await this.remote.disconnect()
      this.retireRefresh()
      this.applyRemote(remote, false)
    } catch (error) {
      this.retireRefresh()
      this.patch({ lastError: errorMessage(error) })
      throw error
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
    try {
      await this.enqueueSend(request)
      if (this.state.lastError !== undefined) this.patch({ lastError: undefined })
    } catch (error) {
      this.patch({ lastError: errorMessage(error) })
      throw error
    }
  }

  /** Pull one incremental Host snapshot through the single-flight gate. */
  async refresh(): Promise<void> {
    if (!await this.refreshWithinTimeout()) this.patch({ lastError: SNAPSHOT_TIMEOUT_MESSAGE })
  }

  private beginRefresh(): Promise<void> {
    const epoch = this.refreshEpoch
    const operation = this.refreshOnce(epoch)
    this.refreshInFlight = operation
    const clear = () => {
      if (this.refreshInFlight === operation) this.refreshInFlight = undefined
    }
    void operation.then(clear, clear)
    return operation
  }

  private async refreshOnce(epoch: number): Promise<void> {
    try {
      const afterSeq = this.state.events.at(-1)?.seq ?? 0
      const remote = await this.remote.snapshot({ afterSeq, limit: this.pollLimit })
      if (epoch !== this.refreshEpoch) return
      this.applyRemote(remote, false)
    } catch (error) {
      if (epoch === this.refreshEpoch) this.patch({ lastError: errorMessage(error) })
    }
  }

  private async refreshWithinTimeout(): Promise<boolean> {
    const operation = this.refreshInFlight ?? this.beginRefresh()
    if (await promiseSettlesWithin(operation, this.snapshotTimeoutMs)) return true
    if (this.refreshInFlight === operation) this.retireRefresh()
    return false
  }

  /** Retire a snapshot without waiting; a late completion cannot publish. */
  private retireRefresh(): void {
    this.refreshEpoch += 1
    this.refreshInFlight = undefined
    if (this.running) this.schedule()
  }

  private applyRemote(remote: SerialSnapshot, forceReset: boolean): void {
    const changedSession = remote.sessionId !== this.state.remote.sessionId
    const replaceWindow = forceReset || changedSession || remote.truncated
    const merged = replaceWindow
      ? [...remote.events]
      : appendUnique(this.state.events, remote.events)
    const events = merged.length > this.maxClientEvents
      ? merged.slice(merged.length - this.maxClientEvents)
      : merged
    const remoteSelection = remote.status === 'connected' ? remote.port : undefined
    this.replace({
      ...this.state,
      remote,
      events,
      selectedPath: remoteSelection?.path ?? this.state.selectedPath,
      baudRate: remoteSelection === undefined
        ? this.state.baudRate
        : String(remoteSelection.baudRate),
      gapDetected: this.state.gapDetected || remote.truncated,
      lastError: remote.status === 'error'
        ? remote.events.findLast(event => event.type === 'error')?.message ?? this.state.lastError
        : this.state.lastError,
    })
  }

  private enqueueSend(request: SerialSendRequest): ReturnType<SerialConsoleRemote['send']> {
    const operation = this.writeTail.then(async () => await this.remote.send(request))
    this.writeTail = operation.then(() => undefined, () => undefined)
    return operation
  }

  private schedule(): void {
    if (!this.running || this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.refreshWithinTimeout().finally(() => { this.schedule() })
    }, this.pollIntervalMs)
  }

  private patch(update: Partial<SerialConsoleViewState>): void {
    this.replace({ ...this.state, ...update })
  }

  private replace(next: SerialConsoleViewState): void {
    this.state = next
    for (const listener of [...this.listeners]) listener()
  }
}

function appendUnique(existing: readonly SerialEvent[], incoming: readonly SerialEvent[]): SerialEvent[] {
  const lastSeq = existing.at(-1)?.seq ?? 0
  return [...existing, ...incoming.filter(event => event.seq > lastSeq)]
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`)
  }
  return value
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function promiseSettlesWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    const timer = setTimeout(() => { resolve(false) }, timeoutMs)
    void promise.then(
      () => { clearTimeout(timer); resolve(true) },
      () => { clearTimeout(timer); resolve(false) },
    )
  })
}
