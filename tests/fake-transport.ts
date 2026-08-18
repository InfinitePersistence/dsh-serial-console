import type { SerialOpenOptions, SerialPortDescriptor } from '../src/protocol.js'
import type {
  Dispose,
  SerialTransport,
  SerialTransportFactory,
} from '../src/serial/transport.js'

export class FakeSerialTransport implements SerialTransport {
  readonly writes: Uint8Array[] = []
  readonly writeStarts: Uint8Array[] = []
  openedWith: SerialOpenOptions | undefined
  closed = false
  writeBarrier: Promise<void> | undefined
  private readonly dataListeners = new Set<(data: Uint8Array) => void>()
  private readonly errorListeners = new Set<(error: Error) => void>()
  private readonly closeListeners = new Set<() => void>()

  async open(options: SerialOpenOptions): Promise<void> {
    this.openedWith = options
  }

  async close(): Promise<void> {
    this.closed = true
    this.emitClose()
  }

  async write(data: Uint8Array): Promise<void> {
    this.writeStarts.push(Uint8Array.from(data))
    await this.writeBarrier
    this.writes.push(Uint8Array.from(data))
  }

  onData(listener: (data: Uint8Array) => void): Dispose {
    this.dataListeners.add(listener)
    return () => { this.dataListeners.delete(listener) }
  }

  onError(listener: (error: Error) => void): Dispose {
    this.errorListeners.add(listener)
    return () => { this.errorListeners.delete(listener) }
  }

  onClose(listener: () => void): Dispose {
    this.closeListeners.add(listener)
    return () => { this.closeListeners.delete(listener) }
  }

  emitData(data: Uint8Array): void {
    for (const listener of [...this.dataListeners]) listener(Uint8Array.from(data))
  }

  emitError(error: Error): void {
    for (const listener of [...this.errorListeners]) listener(error)
  }

  emitClose(): void {
    for (const listener of [...this.closeListeners]) listener()
  }
}

export class FakeSerialTransportFactory implements SerialTransportFactory {
  readonly transports: FakeSerialTransport[] = []
  ports: readonly SerialPortDescriptor[] = [{ path: 'COM_TEST', serialNumber: 'TEST-001' }]

  async list(): Promise<readonly SerialPortDescriptor[]> {
    return this.ports
  }

  create(): FakeSerialTransport {
    const transport = new FakeSerialTransport()
    this.transports.push(transport)
    return transport
  }
}

export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}
