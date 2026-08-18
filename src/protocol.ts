/** Shared wire-safe values used by the Host service, model tools, and browser console. */

export type SerialActor = 'model' | 'user'

export type SerialConnectionStatus =
  | 'disconnected'
  | 'opening'
  | 'connected'
  | 'closing'
  | 'error'

export interface SerialPortDescriptor {
  readonly path: string
  readonly manufacturer?: string
  readonly serialNumber?: string
  readonly vendorId?: string
  readonly productId?: string
  readonly friendlyName?: string
}

export interface SerialOpenOptions {
  readonly path: string
  readonly baudRate: number
  readonly dataBits?: 5 | 6 | 7 | 8
  readonly stopBits?: 1 | 1.5 | 2
  readonly parity?: 'none' | 'even' | 'odd' | 'mark' | 'space'
  readonly rtscts?: boolean
}

interface SerialEventBase {
  /** Opaque id for one physical open/close lifecycle. */
  readonly sessionId: string
  /** Strictly increasing sequence number within the Host process. */
  readonly seq: number
  /** Host wall-clock time in Unix milliseconds. */
  readonly timestamp: number
  /** Host monotonic time, suitable for durations but not wall-clock display. */
  readonly monotonicMs: number
}

export interface SerialReceiveEvent extends SerialEventBase {
  readonly type: 'rx'
  readonly dataBase64: string
  /** Best-effort streaming UTF-8 projection; raw bytes remain authoritative. */
  readonly text?: string
}

export interface SerialTransmitEvent extends SerialEventBase {
  readonly type: 'tx'
  readonly actor: SerialActor
  readonly dataBase64: string
  readonly text?: string
  /** Harness tool call that caused a model write, when available. */
  readonly toolCallId?: string
}

export interface SerialStateEvent extends SerialEventBase {
  readonly type: 'state'
  readonly status: SerialConnectionStatus
  readonly port?: SerialOpenOptions
  readonly message?: string
}

export interface SerialMarkerEvent extends SerialEventBase {
  readonly type: 'marker'
  readonly actor: SerialActor
  readonly label: string
  readonly toolCallId?: string
}

export interface SerialErrorEvent extends SerialEventBase {
  readonly type: 'error'
  readonly code: string
  readonly message: string
}

export type SerialEvent =
  | SerialReceiveEvent
  | SerialTransmitEvent
  | SerialStateEvent
  | SerialMarkerEvent
  | SerialErrorEvent

export interface SerialSnapshot {
  readonly sessionId?: string
  readonly status: SerialConnectionStatus
  readonly port?: SerialOpenOptions
  /** Sequence of the oldest retained event, or nextSeq when the buffer is empty. */
  readonly earliestSeq: number
  /** Sequence that will be assigned to the next event. */
  readonly nextSeq: number
  /** True when afterSeq predates the retained ring buffer. */
  readonly truncated: boolean
  readonly events: readonly SerialEvent[]
}

export interface SerialSnapshotRequest {
  readonly afterSeq?: number
  readonly limit?: number
}

export interface SerialSendRequest {
  readonly actor: SerialActor
  readonly text?: string
  readonly dataBase64?: string
  readonly lineEnding?: 'none' | 'cr' | 'lf' | 'crlf'
  readonly toolCallId?: string
}

export interface SerialSendResult {
  readonly sessionId: string
  readonly seq: number
  readonly byteLength: number
}

export interface SerialExpectRequest {
  readonly pattern: string
  readonly flags?: string
  readonly afterSeq?: number
  readonly timeoutMs?: number
  readonly maxChars?: number
}

export interface SerialExpectResult {
  readonly sessionId: string
  readonly startSeq: number
  readonly endSeq: number
  readonly match: string
  readonly index: number
}

export interface SerialConsoleRemote {
  listPorts(): Promise<readonly SerialPortDescriptor[]>
  connect(options: SerialOpenOptions): Promise<SerialSnapshot>
  disconnect(): Promise<SerialSnapshot>
  snapshot(request?: SerialSnapshotRequest): Promise<SerialSnapshot>
  send(request: SerialSendRequest): Promise<SerialSendResult>
  mark(label: string, actor: SerialActor, toolCallId?: string): Promise<SerialMarkerEvent>
}

/** Decode the mutually exclusive text/base64 request representation. */
export function decodeSendRequest(request: SerialSendRequest): Uint8Array {
  const hasText = request.text !== undefined
  const hasBytes = request.dataBase64 !== undefined
  if (hasText === hasBytes) {
    throw new TypeError('serial send requires exactly one of text or dataBase64')
  }
  if (hasBytes) {
    const binary = globalThis.atob(request.dataBase64 as string)
    return Uint8Array.from(binary, character => character.charCodeAt(0))
  }
  const suffix = request.lineEnding === 'cr' ? '\r'
    : request.lineEnding === 'lf' ? '\n'
      : request.lineEnding === 'crlf' ? '\r\n'
        : ''
  return new TextEncoder().encode(`${request.text as string}${suffix}`)
}
