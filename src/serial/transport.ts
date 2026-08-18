import type { SerialOpenOptions, SerialPortDescriptor } from '../protocol.js'

export type Dispose = () => void

/** Physical serial transport boundary. Tests use a fake; production uses serialport. */
export interface SerialTransport {
  open(options: SerialOpenOptions): Promise<void>
  close(): Promise<void>
  write(data: Uint8Array): Promise<void>
  onData(listener: (data: Uint8Array) => void): Dispose
  onError(listener: (error: Error) => void): Dispose
  onClose(listener: () => void): Dispose
}

export interface SerialTransportFactory {
  list(): Promise<readonly SerialPortDescriptor[]>
  create(): SerialTransport
}

/** Optional append-only observer. Implementations own buffering and I/O failures. */
export interface SerialEventSink {
  write(event: import('../protocol.js').SerialEvent): void
  flush?(): Promise<void>
  close?(): Promise<void>
}

