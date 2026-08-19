import { describe, expect, it, vi } from 'vitest'
import {
  SerialSessionManager,
  SerialExpectTimeoutError,
  SerialSessionManagerClosedError,
} from '../src/serial/session-manager.js'
import { SERIAL_WAIT_SNAPSHOT_CAPABILITY } from '../src/protocol.js'
import { FakeSerialTransportFactory, deferred } from './fake-transport.js'

function manager(factory: FakeSerialTransportFactory, ringCapacity = 20) {
  let wall = 1_700_000_000_000
  let monotonic = 10
  return new SerialSessionManager(factory, {
    ringCapacity,
    snapshotLimit: ringCapacity,
    createSessionId: () => 'serial-session-test',
    now: () => wall++,
    monotonicNow: () => monotonic++,
  })
}

describe('SerialSessionManager', () => {
  it('owns connection state and preserves raw RX bytes with streaming UTF-8 text', async () => {
    const factory = new FakeSerialTransportFactory()
    const serial = manager(factory)
    await serial.connect({ path: 'COM_TEST', baudRate: 115_200 })

    const bytes = new TextEncoder().encode('板卡')
    factory.transports[0]?.emitData(bytes.slice(0, 2))
    factory.transports[0]?.emitData(bytes.slice(2))

    const snapshot = serial.snapshot()
    expect(snapshot.status).toBe('connected')
    expect(snapshot.events.map(event => event.type)).toEqual(['state', 'state', 'rx', 'rx'])
    const rx = snapshot.events.filter(event => event.type === 'rx')
    expect(rx.map(event => event.text ?? '').join('')).toBe('板卡')
    expect(rx.flatMap(event => [...Buffer.from(event.dataBase64, 'base64')])).toEqual([...bytes])
  })

  it('serializes model and user writes through one FIFO', async () => {
    const factory = new FakeSerialTransportFactory()
    const serial = manager(factory)
    await serial.connect({ path: 'COM_TEST', baudRate: 115_200 })
    const gate = deferred()
    const transport = factory.transports[0]
    if (transport === undefined) throw new Error('missing fake transport')
    transport.writeBarrier = gate.promise

    const modelWrite = serial.send(new TextEncoder().encode('reboot\r\n'), {
      actor: 'model', text: 'reboot\r\n', toolCallId: 'call-1',
    })
    const userWrite = serial.send(new TextEncoder().encode('help\r\n'), {
      actor: 'user', text: 'help\r\n',
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(transport.writeStarts.map(bytes => new TextDecoder().decode(bytes))).toEqual(['reboot\r\n'])

    gate.resolve()
    await Promise.all([modelWrite, userWrite])
    expect(transport.writes.map(bytes => new TextDecoder().decode(bytes))).toEqual(['reboot\r\n', 'help\r\n'])
    const tx = serial.snapshot().events.filter(event => event.type === 'tx')
    expect(tx.map(event => event.actor)).toEqual(['model', 'user'])
    expect(tx[0]?.toolCallId).toBe('call-1')
  })

  it('matches expect across transport chunks and reports the event range', async () => {
    const factory = new FakeSerialTransportFactory()
    const serial = manager(factory)
    await serial.connect({ path: 'COM_TEST', baudRate: 115_200 })
    const waiting = serial.waitForText({ pattern: 'login:', timeoutMs: 1_000 })

    factory.transports[0]?.emitData(new TextEncoder().encode('Ubuntu lo'))
    factory.transports[0]?.emitData(new TextEncoder().encode('gin:'))

    await expect(waiting).resolves.toMatchObject({
      sessionId: 'serial-session-test',
      match: 'login:',
    })
  })

  it('times out a bounded expect and removes its listener', async () => {
    const factory = new FakeSerialTransportFactory()
    const serial = manager(factory)
    await serial.connect({ path: 'COM_TEST', baudRate: 115_200 })
    await expect(serial.waitForText({ pattern: 'never', timeoutMs: 5 }))
      .rejects.toBeInstanceOf(SerialExpectTimeoutError)
  })

  it('reports a polling gap when the ring has expired old events', async () => {
    const factory = new FakeSerialTransportFactory()
    const serial = manager(factory, 4)
    await serial.connect({ path: 'COM_TEST', baudRate: 115_200 })
    for (const text of ['1', '2', '3', '4']) {
      factory.transports[0]?.emitData(new TextEncoder().encode(text))
    }
    const snapshot = serial.snapshot(0, 4)
    expect(snapshot.truncated).toBe(true)
    expect(snapshot.events).toHaveLength(4)
    expect(snapshot.earliestSeq).toBe(3)
  })

  it('contains subscriber failures so capture continues', async () => {
    const factory = new FakeSerialTransportFactory()
    const serial = manager(factory)
    await serial.connect({ path: 'COM_TEST', baudRate: 115_200 })
    serial.subscribe(() => { throw new Error('bad observer') })
    factory.transports[0]?.emitData(new TextEncoder().encode('still captured'))
    expect(serial.snapshot().events.at(-1)).toMatchObject({ type: 'rx', text: 'still captured' })
  })

  it('advertises wait capability and returns immediately when waitMs is zero', async () => {
    const factory = new FakeSerialTransportFactory()
    const serial = manager(factory)
    await serial.connect({ path: 'COM_TEST', baudRate: 115_200 })
    const cursor = serial.snapshot().nextSeq - 1

    const result = await serial.waitSnapshot({ afterSeq: cursor, waitMs: 0 })

    expect(result.capabilities?.waitSnapshot).toBe(SERIAL_WAIT_SNAPSHOT_CAPABILITY)
    expect(result.events).toEqual([])
  })

  it('wakes a waiter with the first event published after its cursor', async () => {
    const factory = new FakeSerialTransportFactory()
    const serial = manager(factory)
    await serial.connect({ path: 'COM_TEST', baudRate: 115_200 })
    const cursor = serial.snapshot().nextSeq - 1
    const waiting = serial.waitSnapshot({ afterSeq: cursor, waitMs: 1_000 })

    factory.transports[0]?.emitData(new TextEncoder().encode('ready'))

    await expect(waiting).resolves.toMatchObject({
      events: [{ type: 'rx', text: 'ready' }],
    })
  })

  it('returns an empty snapshot when the wait duration expires', async () => {
    const factory = new FakeSerialTransportFactory()
    const serial = manager(factory)
    await serial.connect({ path: 'COM_TEST', baudRate: 115_200 })
    const cursor = serial.snapshot().nextSeq - 1

    const result = await serial.waitSnapshot({ afterSeq: cursor, waitMs: 5 })

    expect(result.events).toEqual([])
    expect(result.nextSeq).toBe(cursor + 1)
  })

  it('sees an event published between the first snapshot and subscription', async () => {
    const factory = new FakeSerialTransportFactory()
    const serial = manager(factory)
    await serial.connect({ path: 'COM_TEST', baudRate: 115_200 })
    const cursor = serial.snapshot().nextSeq - 1
    const originalSnapshot = serial.snapshot.bind(serial)
    const snapshotSpy = vi.spyOn(serial, 'snapshot')
    snapshotSpy.mockImplementationOnce((afterSeq = 0, limit = 20) => {
      const result = originalSnapshot(afterSeq, limit)
      factory.transports[0]?.emitData(new TextEncoder().encode('between'))
      return result
    })

    const result = await serial.waitSnapshot({ afterSeq: cursor, waitMs: 1_000 })

    expect(result.events).toMatchObject([{ type: 'rx', text: 'between' }])
    expect(snapshotSpy).toHaveBeenCalledTimes(2)
  })

  it('removes an aborted waiter before later serial events arrive', async () => {
    const factory = new FakeSerialTransportFactory()
    const serial = manager(factory)
    await serial.connect({ path: 'COM_TEST', baudRate: 115_200 })
    const cursor = serial.snapshot().nextSeq - 1
    const snapshotSpy = vi.spyOn(serial, 'snapshot')
    const controller = new AbortController()
    const waiting = serial.waitSnapshot({ afterSeq: cursor, waitMs: 1_000 }, controller.signal)
    const callsBeforeAbort = snapshotSpy.mock.calls.length

    controller.abort(new Error('cancelled by test'))
    await expect(waiting).rejects.toThrow('cancelled by test')
    factory.transports[0]?.emitData(new TextEncoder().encode('after abort'))

    expect(snapshotSpy).toHaveBeenCalledTimes(callsBeforeAbort)
  })

  it('rejects active snapshot waiters when the manager closes', async () => {
    const factory = new FakeSerialTransportFactory()
    const serial = manager(factory)
    await serial.connect({ path: 'COM_TEST', baudRate: 115_200 })
    const cursor = serial.snapshot().nextSeq - 1
    const waiting = serial.waitSnapshot({ afterSeq: cursor, waitMs: 1_000 })

    const closing = serial.close()

    await expect(waiting).rejects.toBeInstanceOf(SerialSessionManagerClosedError)
    await closing
  })
})
