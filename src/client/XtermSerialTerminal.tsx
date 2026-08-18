import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import type { IMarker, ITheme } from '@xterm/xterm'
import { useEffect, useRef, useState } from 'react'
import type { SerialActor, SerialEvent } from '../protocol.js'
import type { SerialLineEnding } from './serial-console-store.js'

type GutterActor = SerialActor | 'board' | 'system'

interface GutterRecord {
  readonly marker: IMarker
  actor: GutterActor
}

interface GutterRow {
  readonly id: number
  readonly actor: GutterActor
  readonly top: number
}

interface TerminalRuntime {
  readonly terminal: Terminal
  readonly records: GutterRecord[]
  readonly queue: SerialEvent[]
  readonly txDrafts: Record<SerialActor, string>
  activeActor: SerialActor | undefined
  submitPending: boolean
  draining: boolean
  disposed: boolean
  lastQueuedSeq: number
  gutterSignature: string
}

/** Plain React inputs for the component-private xterm instance. */
export interface XtermSerialTerminalProps {
  readonly events: readonly SerialEvent[]
  readonly connected: boolean
  readonly follow: boolean
  readonly lineEnding: SerialLineEnding
  readonly emptyLabel: string
  readonly onTextInput: (text: string) => Promise<void>
  readonly onBinaryInput: (dataBase64: string) => Promise<void>
}

/**
 * Real VT terminal surface. RX bytes are the only bytes rendered; xterm input
 * is forwarded to the board and returns through the authoritative RX stream.
 */
export function XtermSerialTerminal({
  events,
  connected,
  follow,
  lineEnding,
  emptyLabel,
  onTextInput,
  onBinaryInput,
}: XtermSerialTerminalProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const runtimeRef = useRef<TerminalRuntime>()
  const connectedRef = useRef(connected)
  const followRef = useRef(follow)
  const lineEndingRef = useRef(lineEnding)
  const textInputRef = useRef(onTextInput)
  const binaryInputRef = useRef(onBinaryInput)
  const [gutterRows, setGutterRows] = useState<readonly GutterRow[]>([])

  connectedRef.current = connected
  followRef.current = follow
  lineEndingRef.current = lineEnding
  textInputRef.current = onTextInput
  binaryInputRef.current = onBinaryInput

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    const styles = getComputedStyle(host)
    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: connectedRef.current,
      disableStdin: !connectedRef.current,
      drawBoldTextInBrightColors: true,
      fontFamily: styles.fontFamily,
      fontSize: Number.parseFloat(styles.fontSize),
      scrollback: 10_000,
      theme: terminalTheme(styles),
    })
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(host)
    terminal.textarea?.setAttribute('aria-label', 'Serial terminal input')
    const runtime: TerminalRuntime = {
      terminal,
      records: [],
      queue: [],
      txDrafts: { model: '', user: '' },
      activeActor: undefined,
      submitPending: false,
      draining: false,
      disposed: false,
      lastQueuedSeq: 0,
      gutterSignature: '',
    }
    runtimeRef.current = runtime

    const refresh = () => { refreshGutter(runtime, setGutterRows) }
    const dataDisposable = terminal.onData(data => {
      if (!connectedRef.current || data.length === 0) return
      runtime.activeActor = 'user'
      if (data.includes('\u0003')) runtime.submitPending = true
      markLine(runtime, currentLine(terminal), 'user', refresh)
      void textInputRef.current(data).catch(() => undefined)
    })
    const binaryDisposable = terminal.onBinary(data => {
      if (!connectedRef.current || data.length === 0) return
      runtime.activeActor = 'user'
      markLine(runtime, currentLine(terminal), 'user', refresh)
      void binaryInputRef.current(globalThis.btoa(data)).catch(() => undefined)
    })
    terminal.attachCustomKeyEventHandler(event => {
      if (event.type !== 'keydown' || event.key !== 'Enter' || event.isComposing) return true
      if (!connectedRef.current) return false
      const bytes = lineEndingText(lineEndingRef.current)
      if (bytes.length === 0) return false
      runtime.activeActor = 'user'
      runtime.submitPending = true
      markLine(runtime, currentLine(terminal), 'user', refresh)
      void textInputRef.current(bytes).catch(() => undefined)
      return false
    })
    const renderDisposable = terminal.onRender(refresh)
    const scrollDisposable = terminal.onScroll(refresh)
    const resizeDisposable = terminal.onResize(refresh)
    const resize = () => {
      if (runtime.disposed || host.clientWidth === 0 || host.clientHeight === 0) return
      fitAddon.fit()
      refresh()
    }
    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? undefined
      : new ResizeObserver(resize)
    resizeObserver?.observe(host)
    const animationFrame = requestAnimationFrame(resize)

    return () => {
      runtime.disposed = true
      cancelAnimationFrame(animationFrame)
      resizeObserver?.disconnect()
      dataDisposable.dispose()
      binaryDisposable.dispose()
      renderDisposable.dispose()
      scrollDisposable.dispose()
      resizeDisposable.dispose()
      for (const record of runtime.records) record.marker.dispose()
      terminal.dispose()
      if (runtimeRef.current === runtime) runtimeRef.current = undefined
    }
  }, [])

  useEffect(() => {
    const runtime = runtimeRef.current
    if (runtime === undefined) return
    runtime.terminal.options.disableStdin = !connected
    runtime.terminal.options.cursorBlink = connected
    if (connected) runtime.terminal.focus()
  }, [connected])

  useEffect(() => {
    const runtime = runtimeRef.current
    if (runtime === undefined) return
    for (const event of events) {
      if (event.seq <= runtime.lastQueuedSeq) continue
      runtime.queue.push(event)
      runtime.lastQueuedSeq = event.seq
    }
    drainEvents(runtime, followRef, setGutterRows)
  }, [events])

  return (
    <div className="dsh-serial-terminal-stage" role="application" aria-label="Serial VT terminal">
      <div className="dsh-serial-gutter" aria-label="Terminal source markers">
        {gutterRows.map(row => (
          <span
            key={row.id}
            className={`dsh-serial-gutter-row is-${row.actor}`}
            style={{ top: `${row.top}px` }}
            title={gutterTitle(row.actor)}
          >
            {gutterLabel(row.actor)}
          </span>
        ))}
      </div>
      <div ref={hostRef} className="dsh-serial-xterm-host" />
      {events.length === 0 && <div className="dsh-serial-terminal-hint">{emptyLabel}</div>}
    </div>
  )
}

function drainEvents(
  runtime: TerminalRuntime,
  followRef: { readonly current: boolean },
  setRows: (rows: readonly GutterRow[]) => void,
): void {
  if (runtime.draining || runtime.disposed) return
  const event = runtime.queue.shift()
  if (event === undefined) return
  runtime.draining = true
  const refresh = () => { refreshGutter(runtime, setRows) }
  if (event.type === 'rx') {
    const startLine = currentLine(runtime.terminal)
    runtime.terminal.write(decodeBase64(event.dataBase64), () => {
      if (!runtime.disposed) {
        markReceiveSpan(runtime, startLine, currentLine(runtime.terminal), refresh)
        if (followRef.current) runtime.terminal.scrollToBottom()
      }
      runtime.draining = false
      drainEvents(runtime, followRef, setRows)
    })
    return
  }
  if (event.type === 'tx') observeTransmit(runtime, event, refresh)
  else markLine(runtime, currentLine(runtime.terminal), 'system', refresh)
  runtime.draining = false
  drainEvents(runtime, followRef, setRows)
}

function markReceiveSpan(
  runtime: TerminalRuntime,
  startLine: number,
  endLine: number,
  refresh: () => void,
): void {
  const actor = runtime.activeActor
  if (actor === undefined) {
    for (let line = startLine; line <= endLine; line += 1) {
      markLine(runtime, line, 'board', refresh)
    }
    return
  }

  markLine(runtime, startLine, actor, refresh)
  let crossedHardLine = false
  for (let line = startLine + 1; line <= endLine; line += 1) {
    const wrapped = runtime.terminal.buffer.active.getLine(line)?.isWrapped === true
    if (!wrapped) crossedHardLine = true
    const keepInputOwner = !runtime.submitPending && line === endLine
    markLine(runtime, line, keepInputOwner ? actor : 'board', refresh)
  }
  if (runtime.submitPending && crossedHardLine) {
    runtime.activeActor = undefined
    runtime.submitPending = false
  }
}

function observeTransmit(
  runtime: TerminalRuntime,
  event: Extract<SerialEvent, { type: 'tx' }>,
  refresh: () => void,
): void {
  const text = event.text ?? decodeBase64Text(event.dataBase64)
  let draft = runtime.txDrafts[event.actor]
  let submitted = false
  let submittedCommand: string | undefined
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!
    if (character === '\u001b') {
      index = skipEscape(text, index)
      continue
    }
    if (character === '\u007f' || character === '\b') {
      draft = removeLastCodePoint(draft)
      continue
    }
    if (character === '\r' || character === '\n') {
      if (draft.length !== 0) submittedCommand = draft
      draft = ''
      submitted = true
      continue
    }
    if (character === '\t' || character < ' ') continue
    draft += character
  }
  runtime.txDrafts[event.actor] = draft
  if (submitted) {
    const alreadyVisible = submittedCommand === undefined
      ? false
      : markRecentCommand(runtime, submittedCommand, event.actor, refresh)
    if (!alreadyVisible) {
      runtime.activeActor = event.actor
      runtime.submitPending = true
      markLine(runtime, currentLine(runtime.terminal), event.actor, refresh)
    }
    if (draft.length !== 0) {
      runtime.activeActor = event.actor
      runtime.submitPending = false
      markLine(runtime, currentLine(runtime.terminal), event.actor, refresh)
    }
  } else {
    runtime.activeActor = event.actor
    markLine(runtime, currentLine(runtime.terminal), event.actor, refresh)
  }
}

function markRecentCommand(
  runtime: TerminalRuntime,
  command: string,
  actor: SerialActor,
  refresh: () => void,
): boolean {
  const buffer = runtime.terminal.buffer.active
  const end = currentLine(runtime.terminal)
  const start = Math.max(0, end - Math.min(runtime.terminal.rows, 12))
  for (let line = end; line >= start; line -= 1) {
    const text = buffer.getLine(line)?.translateToString(true) ?? ''
    if (!text.includes(command)) continue
    markLine(runtime, line, actor, refresh, true)
    return true
  }
  return false
}

function markLine(
  runtime: TerminalRuntime,
  line: number,
  actor: GutterActor,
  refresh: () => void,
  force = false,
): void {
  if (runtime.terminal.buffer.active.type !== 'normal') return
  runtime.records.splice(0, runtime.records.length, ...runtime.records.filter(record => !record.marker.isDisposed))
  const existing = runtime.records.find(record => record.marker.line === line)
  if (existing !== undefined) {
    if (force || actorPriority(actor) >= actorPriority(existing.actor)) existing.actor = actor
    refresh()
    return
  }
  const marker = runtime.terminal.registerMarker(line - currentLine(runtime.terminal)) as IMarker | undefined
  if (marker === undefined) return
  const record: GutterRecord = { marker, actor }
  runtime.records.push(record)
  marker.onDispose(refresh)
  refresh()
}

function refreshGutter(
  runtime: TerminalRuntime,
  setRows: (rows: readonly GutterRow[]) => void,
): void {
  if (runtime.disposed) return
  const buffer = runtime.terminal.buffer.active
  const screen = runtime.terminal.element?.querySelector<HTMLElement>('.xterm-screen')
  const host = runtime.terminal.element?.parentElement
  const screenRect = screen?.getBoundingClientRect()
  const hostRect = host?.getBoundingClientRect()
  const rowHeight = screenRect === undefined
    ? 0
    : screenRect.height / Math.max(runtime.terminal.rows, 1)
  const screenTop = screenRect === undefined || hostRect === undefined
    ? 0
    : screenRect.top - hostRect.top
  const actors = new Map<number, GutterRecord>()
  for (const record of runtime.records) {
    if (record.marker.isDisposed || record.marker.line < buffer.viewportY) continue
    if (record.marker.line >= buffer.viewportY + runtime.terminal.rows) continue
    const existing = actors.get(record.marker.line)
    if (existing === undefined || actorPriority(record.actor) >= actorPriority(existing.actor)) {
      actors.set(record.marker.line, record)
    }
  }
  const rows = [...actors.entries()]
    .sort(([left], [right]) => left - right)
    .map(([line, record]) => ({
      id: record.marker.id,
      actor: record.actor,
      top: screenTop + (line - buffer.viewportY) * rowHeight,
    }))
  const signature = rows.map(row => `${row.id}:${row.actor}:${row.top}`).join('|')
  if (signature === runtime.gutterSignature) return
  runtime.gutterSignature = signature
  setRows(rows)
}

function currentLine(terminal: Terminal): number {
  return terminal.buffer.active.baseY + terminal.buffer.active.cursorY
}

function terminalTheme(styles: CSSStyleDeclaration): ITheme {
  return {
    background: requiredVariable(styles, '--serial-terminal-background'),
    foreground: requiredVariable(styles, '--serial-terminal-foreground'),
    cursor: requiredVariable(styles, '--serial-terminal-cursor'),
    cursorAccent: requiredVariable(styles, '--serial-terminal-background'),
    selectionBackground: requiredVariable(styles, '--serial-terminal-selection'),
    scrollbarSliderBackground: requiredVariable(styles, '--serial-terminal-scrollbar'),
    scrollbarSliderHoverBackground: requiredVariable(styles, '--serial-terminal-scrollbar-hover'),
  }
}

function requiredVariable(styles: CSSStyleDeclaration, name: string): string {
  const value = styles.getPropertyValue(name).trim()
  if (value === '') throw new Error(`Missing serial terminal CSS variable ${name}`)
  return value
}

function lineEndingText(lineEnding: SerialLineEnding): string {
  if (lineEnding === 'cr') return '\r'
  if (lineEnding === 'lf') return '\n'
  if (lineEnding === 'crlf') return '\r\n'
  return ''
}

function decodeBase64(value: string): Uint8Array {
  const binary = globalThis.atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function decodeBase64Text(value: string): string {
  return new TextDecoder().decode(decodeBase64(value))
}

function removeLastCodePoint(value: string): string {
  const points = [...value]
  points.pop()
  return points.join('')
}

function skipEscape(value: string, escapeIndex: number): number {
  if (value[escapeIndex + 1] !== '[') return escapeIndex
  let index = escapeIndex + 2
  while (index < value.length && !/[@-~]/.test(value[index]!)) index += 1
  return index
}

function actorPriority(actor: GutterActor): number {
  if (actor === 'user' || actor === 'model') return 3
  if (actor === 'system') return 2
  return 1
}

function gutterLabel(actor: GutterActor): string {
  if (actor === 'user') return 'U'
  if (actor === 'model') return 'M'
  if (actor === 'system') return 'S'
  return 'B'
}

function gutterTitle(actor: GutterActor): string {
  if (actor === 'user') return 'User input'
  if (actor === 'model') return 'Model input'
  if (actor === 'system') return 'System event'
  return 'Board output'
}
