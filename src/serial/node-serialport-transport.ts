import { SerialPort } from 'serialport'
import type { SerialOpenOptions, SerialPortDescriptor } from '../protocol.js'
import type { Dispose, SerialTransport, SerialTransportFactory } from './transport.js'

type ListedPort = Awaited<ReturnType<typeof SerialPort.list>>[number]

/** Production transport backed by the serialport npm package. */
export class NodeSerialPortFactory implements SerialTransportFactory {
  async list(): Promise<readonly SerialPortDescriptor[]> {
    const ports = await SerialPort.list()
    return ports.map(portDescriptor)
  }

  create(): SerialTransport {
    return new NodeSerialPortTransport()
  }
}

class NodeSerialPortTransport implements SerialTransport {
  private port: SerialPort | undefined
  private readonly dataListeners = new Set<(data: Uint8Array) => void>()
  private readonly errorListeners = new Set<(error: Error) => void>()
  private readonly closeListeners = new Set<() => void>()

  async open(options: SerialOpenOptions): Promise<void> {
    if (this.port !== undefined) throw new Error('serial transport is already open')
    const port = new SerialPort({
      path: options.path,
      baudRate: options.baudRate,
      dataBits: options.dataBits ?? 8,
      stopBits: options.stopBits ?? 1,
      parity: options.parity ?? 'none',
      rtscts: options.rtscts ?? false,
      autoOpen: false,
    })
    this.port = port
    port.on('data', (data: Buffer) => {
      const bytes = Uint8Array.from(data)
      for (const listener of [...this.dataListeners]) listener(bytes)
    })
    port.on('error', (error: Error) => {
      for (const listener of [...this.errorListeners]) listener(error)
    })
    port.on('close', () => {
      for (const listener of [...this.closeListeners]) listener()
    })
    await callbackPromise(callback => { port.open(callback) })
  }

  async close(): Promise<void> {
    const port = this.requirePort()
    if (port.isOpen) await callbackPromise(callback => { port.close(callback) })
    this.port = undefined
  }

  async write(data: Uint8Array): Promise<void> {
    const port = this.requirePort()
    await callbackPromise(callback => { port.write(Buffer.from(data), callback) })
    await callbackPromise(callback => { port.drain(callback) })
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

  private requirePort(): SerialPort {
    if (this.port === undefined) throw new Error('serial transport is not open')
    return this.port
  }
}

function callbackPromise(register: (callback: (error: Error | null | undefined) => void) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    register((error) => { if (error == null) resolve(); else reject(error) })
  })
}

function portDescriptor(port: ListedPort): SerialPortDescriptor {
  return {
    path: port.path,
    ...(port.manufacturer === undefined ? {} : { manufacturer: port.manufacturer }),
    ...(port.serialNumber === undefined ? {} : { serialNumber: port.serialNumber }),
    ...(port.vendorId === undefined ? {} : { vendorId: port.vendorId }),
    ...(port.productId === undefined ? {} : { productId: port.productId }),
    ...('friendlyName' in port && typeof port.friendlyName === 'string'
      ? { friendlyName: port.friendlyName }
      : {}),
  }
}
