import { describe, expect, it } from 'vitest'
import { isTerminalFindShortcut, runTerminalSearch } from '../src/client/XtermSerialTerminal.js'

describe('terminal find', () => {
  it('reserves Ctrl+F and Command+F without intercepting other terminal input', () => {
    expect(isTerminalFindShortcut(key('f', { ctrlKey: true }))).toBe(true)
    expect(isTerminalFindShortcut(key('F', { metaKey: true }))).toBe(true)
    expect(isTerminalFindShortcut(key('f', { ctrlKey: true, altKey: true }))).toBe(false)
    expect(isTerminalFindShortcut(key('c', { ctrlKey: true }))).toBe(false)
  })

  it('uses case-insensitive decorated search and only marks forward typing incremental', () => {
    const calls: Array<{ readonly direction: string; readonly term: string; readonly options: object | undefined }> = []
    const search = {
      findNext(term: string, options?: object) {
        calls.push({ direction: 'next', term, options })
        return true
      },
      findPrevious(term: string, options?: object) {
        calls.push({ direction: 'previous', term, options })
        return true
      },
    }

    runTerminalSearch(search, 'ready', 'next', true)
    runTerminalSearch(search, 'ready', 'previous', false)

    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({
      direction: 'next',
      term: 'ready',
      options: { caseSensitive: false, incremental: true },
    })
    expect(calls[1]).toMatchObject({
      direction: 'previous',
      term: 'ready',
      options: { caseSensitive: false },
    })
    expect(calls[0]?.options).toHaveProperty('decorations.matchOverviewRuler', '#c99a2e')
    expect(calls[1]?.options).not.toHaveProperty('incremental')
  })
})

function key(
  value: string,
  modifiers: Partial<{ readonly ctrlKey: boolean; readonly metaKey: boolean; readonly altKey: boolean }> = {},
) {
  return {
    key: value,
    ctrlKey: modifiers.ctrlKey ?? false,
    metaKey: modifiers.metaKey ?? false,
    altKey: modifiers.altKey ?? false,
  }
}
