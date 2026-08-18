import { describe, expect, it } from 'vitest'
import { decodeSendRequest } from '../src/protocol.js'

describe('decodeSendRequest', () => {
  it('adds only an explicitly requested line ending', () => {
    expect([...decodeSendRequest({ actor: 'user', text: 'ls', lineEnding: 'cr' })])
      .toEqual([0x6c, 0x73, 0x0d])
    expect([...decodeSendRequest({ actor: 'user', text: 'ls\t', lineEnding: 'none' })])
      .toEqual([0x6c, 0x73, 0x09])
    expect(new TextDecoder().decode(decodeSendRequest({ actor: 'user', text: 'help', lineEnding: 'crlf' })))
      .toBe('help\r\n')
    expect(new TextDecoder().decode(decodeSendRequest({ actor: 'user', text: 'help', lineEnding: 'none' })))
      .toBe('help')
  })

  it('requires exactly one payload representation', () => {
    expect(() => decodeSendRequest({ actor: 'model' })).toThrow(/exactly one/)
    expect(() => decodeSendRequest({ actor: 'model', text: 'a', dataBase64: 'Yg==' })).toThrow(/exactly one/)
  })
})
