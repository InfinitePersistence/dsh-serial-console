import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import type { IMarker, ITheme } from '@xterm/xterm'
import { useEffect, useRef, useState } from 'react'
import type { SerialActor, SerialEvent } from '../protocol.js'
import type { SerialLineEnding } from './serial-console-store.js'
import {
  advanceTerminalTransmit,
  findTerminalSubmissionMatch,
  mapTerminalInput,
} from './terminal-transmit.js'
import type { TerminalSubmission } from './terminal-transmit.js'

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

interface ReceiveSpan {
  readonly eventSeq: number
  readonly startLine: number
  readonly endLine: number
}

interface PendingSubmission {
  readonly actor: SerialActor
  readonly command: string | undefined
  readonly lineText: string | undefined
  readonly minLine: number
  readonly txSeq: number
}

interface TerminalRuntime {
  readonly terminal: Terminal
  readonly records: GutterRecord[]
  readonly queue: SerialEvent[]
  readonly txDrafts: Record<SerialActor, string>
  readonly txOpaque: Record<SerialActor, boolean>
  readonly pendingSubmissions: PendingSubmission[]
  draining: boolean
  disposed: boolean
  lastQueuedSeq: number
  readonly receiveTail: ReceiveSpan[]
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
      txOpaque: { model: false, user: false },
      pendingSubmissions: [],
      draining: false,
      disposed: false,
      lastQueuedSeq: 0,
      receiveTail: [],
      gutterSignature: '',
    }
    runtimeRef.current = runtime

    const refresh = () => { refreshGutter(runtime, setGutterRows) }
    const dataDisposable = terminal.onData(data => {
      if (!connectedRef.current || data.length === 0) return
      const outgoing = mapTerminalInput(data, lineEndingRef.current)
      if (outgoing.length === 0) return
      void textInputRef.current(outgoing).catch(() => undefined)
    })
    const binaryDisposable = terminal.onBinary(data => {
      if (!connectedRef.current || data.length === 0) return
      void binaryInputRef.current(globalThis.btoa(data)).catch(() => undefined)
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
    else {
      runtime.receiveTail.splice(0)
      runtime.pendingSubmissions.splice(0)
      runtime.txDrafts.user = ''
      runtime.txDrafts.model = ''
      runtime.txOpaque.user = false
      runtime.txOpaque.model = false
    }
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
        const span = describeReceiveSpan(
          event.seq,
          startLine,
          currentLine(runtime.terminal),
        )
        markReceiveSpan(runtime, span, refresh)
        const previous = runtime.receiveTail.at(-1)
        if (previous !== undefined && previous.eventSeq + 1 !== span.eventSeq) {
          runtime.receiveTail.splice(0)
        }
        runtime.receiveTail.push(span)
        if (runtime.receiveTail.length > 16) runtime.receiveTail.shift()
        if (followRef.current) runtime.terminal.scrollToBottom()
      }
      runtime.draining = false
      drainEvents(runtime, followRef, setRows)
    })
    return
  }
  if (event.type === 'tx') observeTransmit(runtime, event, refresh)
  else {
    runtime.receiveTail.splice(0)
    markLine(runtime, currentLine(runtime.terminal), 'system', refresh)
  }
  runtime.draining = false
  drainEvents(runtime, followRef, setRows)
}

function markReceiveSpan(
  runtime: TerminalRuntime,
  span: ReceiveSpan,
  refresh: () => void,
): void {
  for (let line = span.startLine; line <= span.endLine; line += 1) {
    markBoardLine(runtime, line, refresh, false)
  }
  resolvePendingSubmissions(runtime, refresh)
}

function describeReceiveSpan(
  eventSeq: number,
  startLine: number,
  endLine: number,
): ReceiveSpan {
  return { eventSeq, startLine, endLine }
}

function observeTransmit(
  runtime: TerminalRuntime,
  event: Extract<SerialEvent, { type: 'tx' }>,
  refresh: () => void,
): void {
  const text = event.text ?? decodeBase64Text(event.dataBase64)
  const precedingReceive = combineReceiveTail(runtime.receiveTail)
  runtime.receiveTail.splice(0)
  const submissions = observeTransmitText(runtime, event.actor, text)
  if (submissions.length === 0) return
  const receivedBeforeTransmit = precedingReceive !== undefined
    && precedingReceive.eventSeq + 1 === event.seq
  for (const submission of submissions) {
    const correlated = receivedBeforeTransmit && precedingReceive !== undefined
      ? markCorrelatedSubmission(runtime, precedingReceive, submission, event.actor, refresh)
      : false
    if (correlated) continue
    const lineText = activeLineText(runtime.terminal)
    runtime.pendingSubmissions.push({
      actor: event.actor,
      command: submission.command,
      lineText: submission.opaque
        || (submission.command !== undefined && lineText?.endsWith(submission.command) === true)
        ? lineText
        : undefined,
      minLine: activeLogicalLineStart(runtime.terminal),
      txSeq: event.seq,
    })
  }
  if (runtime.pendingSubmissions.length > 128) runtime.pendingSubmissions.splice(0, 64)
}

function observeTransmitText(
  runtime: TerminalRuntime,
  actor: SerialActor,
  text: string,
): readonly TerminalSubmission[] {
  const update = advanceTerminalTransmit({
    draft: runtime.txDrafts[actor],
    opaque: runtime.txOpaque[actor],
  }, text)
  runtime.txDrafts[actor] = update.state.draft
  runtime.txOpaque[actor] = update.state.opaque
  return update.submissions
}

function combineReceiveTail(spans: readonly ReceiveSpan[]): ReceiveSpan | undefined {
  const first = spans[0]
  const last = spans.at(-1)
  if (first === undefined || last === undefined) return undefined
  return describeReceiveSpan(
    last.eventSeq,
    first.startLine,
    last.endLine,
  )
}

function markBoardLine(
  runtime: TerminalRuntime,
  line: number,
  refresh: () => void,
  force: boolean,
): void {
  const text = runtime.terminal.buffer.active.getLine(line)?.translateToString(true) ?? ''
  if (text.length !== 0) {
    markLine(runtime, line, 'board', refresh, force)
    return
  }
  if (force) clearLineMarkers(runtime, line, refresh)
}

function clearLineMarkers(runtime: TerminalRuntime, line: number, refresh: () => void): void {
  for (const record of [...runtime.records]) {
    if (!record.marker.isDisposed && record.marker.line === line) record.marker.dispose()
  }
  runtime.records.splice(0, runtime.records.length, ...runtime.records.filter(record => !record.marker.isDisposed))
  refresh()
}

function markCorrelatedSubmission(
  runtime: TerminalRuntime,
  span: ReceiveSpan,
  submission: TerminalSubmission,
  actor: SerialActor,
  refresh: () => void,
): boolean {
  const activeStart = activeLogicalLineStart(runtime.terminal)
  for (let line = Math.min(span.endLine, activeStart - 1); line >= span.startLine; line -= 1) {
    if (hasCommandAttribution(runtime, line)) continue
    const text = runtime.terminal.buffer.active.getLine(line)?.translateToString(true).trimEnd() ?? ''
    if (text.length === 0) continue
    if (!submission.opaque
      && submission.command !== undefined
      && !text.endsWith(submission.command)) continue
    markLine(runtime, line, actor, refresh, true)
    return true
  }
  return false
}

function resolvePendingSubmissions(runtime: TerminalRuntime, refresh: () => void): void {
  const claimed = new Set<number>()
  for (let index = 0; index < runtime.pendingSubmissions.length;) {
    const pending = runtime.pendingSubmissions[index]!
    const line = findPendingSubmissionLine(runtime, pending, claimed)
    if (line === undefined) {
      if (runtime.lastQueuedSeq - pending.txSeq > 512) runtime.pendingSubmissions.splice(index, 1)
      else index += 1
      continue
    }
    markLine(runtime, line, pending.actor, refresh, true)
    claimed.add(line)
    runtime.pendingSubmissions.splice(index, 1)
  }
}

function findPendingSubmissionLine(
  runtime: TerminalRuntime,
  pending: PendingSubmission,
  claimed: ReadonlySet<number>,
): number | undefined {
  const { terminal } = runtime
  const end = activeLogicalLineStart(terminal) - 1
  const start = Math.max(pending.minLine, end - Math.min(terminal.rows * 2, 64))
  const rows = []
  for (let line = end; line >= start; line -= 1) {
    const text = terminal.buffer.active.getLine(line)?.translateToString(true).trimEnd() ?? ''
    rows.push({
      line,
      text,
      claimed: claimed.has(line) || hasCommandAttribution(runtime, line),
    })
  }
  return findTerminalSubmissionMatch(pending, rows)
}

function hasCommandAttribution(runtime: TerminalRuntime, line: number): boolean {
  return runtime.records.some(record => !record.marker.isDisposed
    && record.marker.line === line
    && (record.actor === 'user' || record.actor === 'model'))
}

function activeLineText(terminal: Terminal): string | undefined {
  const text = terminal.buffer.active.getLine(currentLine(terminal))?.translateToString(true).trimEnd() ?? ''
  return text === '' ? undefined : text
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
  const activeStart = activeLogicalLineStart(runtime.terminal)
  const activeEnd = currentLine(runtime.terminal)
  for (const record of runtime.records) {
    if (record.marker.isDisposed || record.marker.line < buffer.viewportY) continue
    if (record.marker.line >= buffer.viewportY + runtime.terminal.rows) continue
    if (record.marker.line >= activeStart && record.marker.line <= activeEnd) continue
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

function activeLogicalLineStart(terminal: Terminal): number {
  let line = currentLine(terminal)
  while (line > 0 && terminal.buffer.active.getLine(line)?.isWrapped === true) line -= 1
  return line
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

function decodeBase64(value: string): Uint8Array {
  const binary = globalThis.atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function decodeBase64Text(value: string): string {
  return new TextDecoder().decode(decodeBase64(value))
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
