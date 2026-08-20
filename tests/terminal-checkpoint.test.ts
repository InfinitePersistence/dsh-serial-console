import { describe, expect, it } from 'vitest'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Terminal } from '@xterm/xterm'
import type { SerialEvent } from '../src/protocol.js'
import {
  createTerminalCheckpointCache,
  saveTerminalCheckpoint,
  takeRestorableTerminalCheckpoint,
} from '../src/client/terminal-checkpoint.js'
import type { TerminalCheckpointLookup } from '../src/client/terminal-checkpoint.js'

describe('terminal checkpoint continuity', () => {
  it('restores serialized xterm contents, cursor, and dimensions before open', async () => {
    const source = new Terminal({ cols: 12, rows: 3, scrollback: 10 })
    const serialize = new SerializeAddon()
    source.loadAddon(serialize)
    await writeTerminal(source, 'hello\r\n\u001b[31mworld\u001b[0m')

    const restored = new Terminal({ cols: source.cols, rows: source.rows, scrollback: 10 })
    restored.loadAddon(new SerializeAddon())
    await writeTerminal(restored, serialize.serialize())

    expect(restored.cols).toBe(12)
    expect(restored.rows).toBe(3)
    expect(restored.buffer.active.getLine(0)?.translateToString(true)).toBe('hello')
    expect(restored.buffer.active.getLine(1)?.translateToString(true)).toBe('world')
    expect(restored.buffer.active.cursorX).toBe(5)
    expect(restored.buffer.active.cursorY).toBe(1)
    source.dispose()
    restored.dispose()
  })

  it('restores one session checkpoint and accepts a continuous event suffix', () => {
    const cache = createTerminalCheckpointCache<{ readonly serialized: string }>()
    const checkpoint = {
      key: 'session-1:0',
      baseSeq: 0,
      throughSeq: 2,
      cols: 80,
      rows: 24,
      payload: { serialized: 'screen' },
    }
    saveTerminalCheckpoint(cache, checkpoint)

    expect(takeRestorableTerminalCheckpoint(cache, {
      key: 'session-1:0',
      baseSeq: 0,
      events: [event(1), event(2), event(3)],
      allowRestore: true,
    })).toBe(checkpoint)
  })

  it.each([
    ['another session', { key: 'session-2:0', baseSeq: 0, events: [event(4)], allowRestore: true }],
    ['another clear generation', { key: 'session-1:3', baseSeq: 3, events: [event(4)], allowRestore: true }],
    ['a ring gap', { key: 'session-1:0', baseSeq: 0, events: [event(4)], allowRestore: true }],
    ['an internal suffix gap', { key: 'session-1:0', baseSeq: 0, events: [event(3), event(5)], allowRestore: true }],
    ['a rewound event window', { key: 'session-1:0', baseSeq: 0, events: [event(1)], allowRestore: true }],
    ['a reported truncation', { key: 'session-1:0', baseSeq: 0, events: [event(3)], allowRestore: false }],
  ])('discards the checkpoint for %s', (_label: string, lookup: TerminalCheckpointLookup) => {
    const cache = createTerminalCheckpointCache<{ readonly serialized: string }>()
    saveTerminalCheckpoint(cache, {
      key: 'session-1:0',
      baseSeq: 0,
      throughSeq: 2,
      cols: 80,
      rows: 24,
      payload: { serialized: 'screen' },
    })

    expect(takeRestorableTerminalCheckpoint(cache, lookup)).toBeUndefined()
    expect(cache.current).toBeUndefined()
  })
})

function event(seq: number): SerialEvent {
  return {
    type: 'state',
    sessionId: 'session-1',
    seq,
    timestamp: seq,
    monotonicMs: seq,
    status: 'connected',
  }
}

function writeTerminal(terminal: Terminal, data: string): Promise<void> {
  return new Promise(resolve => { terminal.write(data, resolve) })
}
