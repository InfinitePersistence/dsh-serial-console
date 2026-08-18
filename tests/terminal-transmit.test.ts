import { describe, expect, it } from 'vitest'
import {
  advanceTerminalTransmit,
  findTerminalSubmissionMatch,
  isReplayingTerminalEvent,
  isTerminalGeneratedReply,
  mapTerminalInput,
} from '../src/client/terminal-transmit.js'

const empty = { draft: '', opaque: false } as const

describe('terminal TX submission tracking', () => {
  it('does not attribute one or many empty Enters to the user', () => {
    expect(advanceTerminalTransmit(empty, '\r').submissions).toEqual([])
    expect(advanceTerminalTransmit(empty, '\r\r\r').submissions).toEqual([])
    expect(advanceTerminalTransmit(empty, '\r\n').submissions).toEqual([])
  })

  it('maps one xterm Enter token through exactly one line-ending path', () => {
    expect(mapTerminalInput('\r', 'cr')).toBe('\r')
    expect(mapTerminalInput('\r', 'crlf')).toBe('\r\n')
    expect(mapTerminalInput('\r', 'lf')).toBe('\n')
    expect(mapTerminalInput('\r', 'none')).toBe('')
    expect(mapTerminalInput('paste\rdata', 'lf')).toBe('paste\rdata')
  })

  it('suppresses terminal-generated replies only while historical RX is replayed', () => {
    expect(isReplayingTerminalEvent(20, 19)).toBe(true)
    expect(isReplayingTerminalEvent(20, 20)).toBe(true)
    expect(isReplayingTerminalEvent(20, 21)).toBe(false)
    expect(isReplayingTerminalEvent(20, undefined)).toBe(false)
    expect(isTerminalGeneratedReply('\u001b[2;21R')).toBe(true)
    expect(isTerminalGeneratedReply('\u001b[?1;2c')).toBe(true)
    expect(isTerminalGeneratedReply('\u001b[A')).toBe(false)
    expect(isTerminalGeneratedReply('echo 1')).toBe(false)
  })

  it('recognises a printable command only when it is submitted', () => {
    const typed = advanceTerminalTransmit(empty, 'uname -a')
    expect(typed.submissions).toEqual([])
    expect(advanceTerminalTransmit(typed.state, '\r').submissions).toEqual([
      { command: 'uname -a', opaque: false },
    ])
  })

  it('treats history recall as visible input but ignores an empty left arrow', () => {
    const history = advanceTerminalTransmit(empty, '\u001b[A')
    expect(advanceTerminalTransmit(history.state, '\r').submissions).toEqual([
      { command: undefined, opaque: true },
    ])

    const left = advanceTerminalTransmit(empty, '\u001b[D')
    expect(advanceTerminalTransmit(left.state, '\r').submissions).toEqual([])
  })

  it('keeps Tab-completed input opaque until the completed row can be matched', () => {
    const partial = advanceTerminalTransmit(empty, 'grep /va\t')
    expect(partial.state.opaque).toBe(true)
    expect(advanceTerminalTransmit(partial.state, 'r\r').submissions).toEqual([
      { command: 'grep /var', opaque: true },
    ])
  })

  it('never lets rapid identical submissions claim the same completed row', () => {
    const target = { command: 'echo 1', lineText: undefined, minLine: 10 }
    const rows = [
      { line: 12, text: 'root@rk3588:~# echo 1', claimed: false },
      { line: 11, text: 'root@rk3588:~# echo 1', claimed: true },
    ]
    expect(findTerminalSubmissionMatch(target, rows)).toBe(12)
    expect(findTerminalSubmissionMatch(target, rows.map(row => ({ ...row, claimed: true })))).toBeUndefined()
  })
})
