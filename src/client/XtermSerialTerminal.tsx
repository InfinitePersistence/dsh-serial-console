import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import type { ISearchOptions, ISearchResultChangeEvent } from '@xterm/addon-search'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Terminal } from '@xterm/xterm'
import type { IMarker, ITheme } from '@xterm/xterm'
import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { SerialActor, SerialEvent } from '../protocol.js'
import type { SerialLineEnding } from './serial-console-store.js'
import {
  takeRestorableTerminalCheckpoint,
  saveTerminalCheckpoint,
} from './terminal-checkpoint.js'
import type {
  TerminalCheckpoint,
  TerminalCheckpointCache,
} from './terminal-checkpoint.js'
import {
  advanceTerminalTransmit,
  findTerminalSubmissionMatch,
  isReplayingTerminalEvent,
  isTerminalGeneratedReply,
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

interface CachedGutterRecord {
  readonly line: number
  readonly actor: GutterActor
}

export interface XtermTerminalCheckpointPayload {
  readonly serializedTerminal: string
  readonly bufferSignature: string
  readonly records: readonly CachedGutterRecord[]
  readonly txDrafts: Readonly<Record<SerialActor, string>>
  readonly txOpaque: Readonly<Record<SerialActor, boolean>>
  readonly pendingSubmissions: readonly PendingSubmission[]
  readonly receiveTail: readonly ReceiveSpan[]
}

interface TerminalRuntime {
  readonly terminal: Terminal
  readonly searchAddon: SearchAddon
  readonly serializeAddon: SerializeAddon
  readonly checkpointCache: TerminalCheckpointCache<XtermTerminalCheckpointPayload>
  readonly checkpointKey: string
  readonly checkpointBaseSeq: number
  checkpointAllowed: boolean
  readonly records: GutterRecord[]
  readonly queue: SerialEvent[]
  readonly txDrafts: Record<SerialActor, string>
  readonly txOpaque: Record<SerialActor, boolean>
  readonly pendingSubmissions: PendingSubmission[]
  draining: boolean
  disposed: boolean
  lastQueuedSeq: number
  processedThroughSeq: number
  readonly receiveTail: ReceiveSpan[]
  readonly replayThroughSeq: number
  readyToDrain: boolean
  restoring: boolean
  processingRxSeq: number | undefined
  checkpointTimer: ReturnType<typeof setTimeout> | undefined
  revealFrame: number | undefined
  completeInitialRestore: () => void
  gutterSignature: string
}

/** Plain React inputs for the component-private xterm instance. */
export interface XtermSerialTerminalProps {
  readonly events: readonly SerialEvent[]
  readonly connected: boolean
  readonly follow: boolean
  readonly lineEnding: SerialLineEnding
  readonly emptyLabel: string
  readonly checkpointKey: string
  readonly checkpointBaseSeq: number
  readonly checkpointAllowed: boolean
  readonly checkpointCache: TerminalCheckpointCache<XtermTerminalCheckpointPayload>
  readonly findOpen: boolean
  readonly onFindOpenChange: (open: boolean) => void
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
  checkpointKey,
  checkpointBaseSeq,
  checkpointAllowed,
  checkpointCache,
  findOpen,
  onFindOpenChange,
  onTextInput,
  onBinaryInput,
}: XtermSerialTerminalProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const runtimeRef = useRef<TerminalRuntime>()
  const searchInputRef = useRef<HTMLInputElement>(null)
  const connectedRef = useRef(connected)
  const followRef = useRef(follow)
  const lineEndingRef = useRef(lineEnding)
  const textInputRef = useRef(onTextInput)
  const binaryInputRef = useRef(onBinaryInput)
  const findOpenChangeRef = useRef(onFindOpenChange)
  const eventsRef = useRef(events)
  const replayThroughSeqRef = useRef(events.at(-1)?.seq ?? checkpointBaseSeq)
  const checkpointCandidateRef = useRef<TerminalCheckpoint<XtermTerminalCheckpointPayload> | null>()
  if (checkpointCandidateRef.current === undefined) {
    checkpointCandidateRef.current = takeRestorableTerminalCheckpoint(checkpointCache, {
      key: checkpointKey,
      baseSeq: checkpointBaseSeq,
      events,
      allowRestore: checkpointAllowed,
    }) ?? null
  }
  const checkpointCandidate = checkpointCandidateRef.current ?? null
  const [restoring, setRestoring] = useState(
    checkpointCandidate !== null || replayThroughSeqRef.current > checkpointBaseSeq,
  )
  const [gutterRows, setGutterRows] = useState<readonly GutterRow[]>([])
  const [searchTerm, setSearchTerm] = useState('')
  const [searchResults, setSearchResults] = useState<ISearchResultChangeEvent>(EMPTY_SEARCH_RESULTS)

  connectedRef.current = connected
  followRef.current = follow
  lineEndingRef.current = lineEnding
  textInputRef.current = onTextInput
  binaryInputRef.current = onBinaryInput
  findOpenChangeRef.current = onFindOpenChange
  eventsRef.current = events

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    const styles = getComputedStyle(host)
    const checkpoint = checkpointCandidateRef.current ?? null
    const terminal = new Terminal({
      // SearchAddon decorations and result tracking use xterm's proposed
      // decoration API. The lockfile pins compatible addon and xterm versions.
      allowProposedApi: true,
      convertEol: false,
      cursorBlink: connectedRef.current,
      disableStdin: true,
      drawBoldTextInBrightColors: true,
      fontFamily: styles.fontFamily,
      fontSize: Number.parseFloat(styles.fontSize),
      scrollback: 10_000,
      theme: terminalTheme(styles),
      ...(checkpoint === null ? {} : { cols: checkpoint.cols, rows: checkpoint.rows }),
    })
    const fitAddon = new FitAddon()
    const searchAddon = new SearchAddon({ highlightLimit: 1_000 })
    const serializeAddon = new SerializeAddon()
    terminal.loadAddon(fitAddon)
    terminal.loadAddon(searchAddon)
    terminal.loadAddon(serializeAddon)
    const runtime: TerminalRuntime = {
      terminal,
      searchAddon,
      serializeAddon,
      checkpointCache,
      checkpointKey,
      checkpointBaseSeq,
      checkpointAllowed,
      records: [],
      queue: [],
      txDrafts: { model: '', user: '' },
      txOpaque: { model: false, user: false },
      pendingSubmissions: [],
      draining: false,
      disposed: false,
      lastQueuedSeq: checkpoint?.throughSeq ?? checkpointBaseSeq,
      processedThroughSeq: checkpoint?.throughSeq ?? checkpointBaseSeq,
      receiveTail: [],
      replayThroughSeq: replayThroughSeqRef.current,
      readyToDrain: false,
      restoring: checkpoint !== null || replayThroughSeqRef.current > checkpointBaseSeq,
      processingRxSeq: undefined,
      checkpointTimer: undefined,
      revealFrame: undefined,
      completeInitialRestore: () => undefined,
      gutterSignature: '',
    }
    runtimeRef.current = runtime

    const searchDisposable = searchAddon.onDidChangeResults(setSearchResults)
    terminal.attachCustomKeyEventHandler(event => {
      if (!isTerminalFindShortcut(event)) return true
      event.preventDefault()
      event.stopPropagation()
      searchInputRef.current?.focus()
      searchInputRef.current?.select()
      findOpenChangeRef.current(true)
      return false
    })

    const refresh = () => { refreshGutter(runtime, setGutterRows) }
    const dataDisposable = terminal.onData(data => {
      if (runtime.restoring || !connectedRef.current || data.length === 0) return
      if (isReplayingTerminalEvent(runtime.replayThroughSeq, runtime.processingRxSeq)
        && isTerminalGeneratedReply(data)) return
      const outgoing = mapTerminalInput(data, lineEndingRef.current)
      if (outgoing.length === 0) return
      void textInputRef.current(outgoing).catch(() => undefined)
    })
    const binaryDisposable = terminal.onBinary(data => {
      if (runtime.restoring || !connectedRef.current || data.length === 0) return
      void binaryInputRef.current(globalThis.btoa(data)).catch(() => undefined)
    })
    let renderDisposable: { dispose(): void } | undefined
    let scrollDisposable: { dispose(): void } | undefined
    let resizeDisposable: { dispose(): void } | undefined
    let resizeObserver: ResizeObserver | undefined
    let initialResizeFrame: number | undefined
    const resize = () => {
      if (runtime.disposed || host.clientWidth === 0 || host.clientHeight === 0) return
      fitAddon.fit()
      refresh()
      scheduleCheckpoint(runtime)
    }
    const revealWhenCaughtUp = () => {
      if (runtime.disposed
        || !runtime.restoring
        || !runtime.readyToDrain
        || runtime.processedThroughSeq < runtime.replayThroughSeq
        || runtime.revealFrame !== undefined) return
      runtime.terminal.scrollToBottom()
      runtime.revealFrame = requestAnimationFrame(() => {
        runtime.revealFrame = undefined
        if (runtime.disposed) return
        runtime.restoring = false
        runtime.terminal.options.disableStdin = !connectedRef.current
        runtime.terminal.options.cursorBlink = connectedRef.current
        if (connectedRef.current) runtime.terminal.focus()
        refresh()
        setRestoring(false)
        scheduleCheckpoint(runtime)
      })
    }
    runtime.completeInitialRestore = revealWhenCaughtUp
    const openTerminal = () => {
      if (runtime.disposed) return
      terminal.open(host)
      terminal.textarea?.setAttribute('aria-label', 'Serial terminal input')
      renderDisposable = terminal.onRender(refresh)
      scrollDisposable = terminal.onScroll(refresh)
      resizeDisposable = terminal.onResize(refresh)
      resizeObserver = typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver(resize)
      resizeObserver?.observe(host)
      initialResizeFrame = requestAnimationFrame(resize)
    }
    const startDraining = () => {
      runtime.readyToDrain = true
      runtime.completeInitialRestore()
      drainEvents(runtime, followRef, setGutterRows)
    }
    const replayWithoutCheckpoint = () => {
      checkpointCache.current = undefined
      terminal.reset()
      resetCheckpointState(runtime)
      const retained = eventsRef.current.filter(event => event.seq > checkpointBaseSeq)
      runtime.queue.splice(0, runtime.queue.length, ...retained)
      runtime.lastQueuedSeq = retained.at(-1)?.seq ?? checkpointBaseSeq
      runtime.processedThroughSeq = checkpointBaseSeq
      openTerminal()
      startDraining()
    }
    const finishCheckpointRestore = () => {
      if (runtime.disposed || checkpoint === null) return
      if (terminalBufferSignature(terminal) !== checkpoint.payload.bufferSignature) {
        replayWithoutCheckpoint()
        return
      }
      restoreCheckpointState(runtime, checkpoint.payload, refresh)
      openTerminal()
      startDraining()
    }

    if (checkpoint === null) {
      openTerminal()
      startDraining()
    } else {
      try {
        if (checkpoint.payload.serializedTerminal === '') finishCheckpointRestore()
        else terminal.write(checkpoint.payload.serializedTerminal, finishCheckpointRestore)
      } catch {
        replayWithoutCheckpoint()
      }
    }

    return () => {
      // A view switch unmounts this component. Capture the latest stable
      // terminal before disposing xterm so the next mount does not replay it.
      saveRuntimeCheckpoint(runtime)
      runtime.disposed = true
      if (runtime.checkpointTimer !== undefined) clearTimeout(runtime.checkpointTimer)
      if (runtime.revealFrame !== undefined) cancelAnimationFrame(runtime.revealFrame)
      if (initialResizeFrame !== undefined) cancelAnimationFrame(initialResizeFrame)
      resizeObserver?.disconnect()
      dataDisposable.dispose()
      binaryDisposable.dispose()
      searchDisposable.dispose()
      renderDisposable?.dispose()
      scrollDisposable?.dispose()
      resizeDisposable?.dispose()
      for (const record of runtime.records) record.marker.dispose()
      terminal.dispose()
      if (runtimeRef.current === runtime) runtimeRef.current = undefined
    }
  }, [])

  useEffect(() => {
    const runtime = runtimeRef.current
    if (runtime === undefined) return
    if (!findOpen) {
      clearTerminalSearch(runtime)
      setSearchResults(EMPTY_SEARCH_RESULTS)
      if (connectedRef.current) runtime.terminal.focus()
      return
    }
    if (restoring) return

    if (searchTerm !== '') runTerminalSearch(runtime.searchAddon, searchTerm, 'next', true)
    const focusFrame = requestAnimationFrame(() => {
      searchInputRef.current?.focus()
      searchInputRef.current?.select()
    })
    return () => { cancelAnimationFrame(focusFrame) }
  }, [findOpen, restoring])

  useEffect(() => {
    const runtime = runtimeRef.current
    if (runtime === undefined) return
    runtime.terminal.options.disableStdin = runtime.restoring || !connected
    runtime.terminal.options.cursorBlink = connected
    if (connected) {
      if (!runtime.restoring) runtime.terminal.focus()
    } else {
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
    runtime.checkpointAllowed = checkpointAllowed
    if (!checkpointAllowed) checkpointCache.current = undefined
  }, [checkpointAllowed, checkpointCache])

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

  const updateSearchTerm = (term: string) => {
    setSearchTerm(term)
    const runtime = runtimeRef.current
    if (runtime === undefined || restoring) return
    if (term === '') {
      clearTerminalSearch(runtime)
      setSearchResults(EMPTY_SEARCH_RESULTS)
      return
    }
    runTerminalSearch(runtime.searchAddon, term, 'next', true)
  }

  const navigateSearch = (direction: 'next' | 'previous') => {
    const runtime = runtimeRef.current
    if (runtime === undefined || restoring || searchTerm === '') return
    runTerminalSearch(runtime.searchAddon, searchTerm, direction, false)
  }

  const handleSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (isTerminalFindShortcut(event)) {
      event.preventDefault()
      event.stopPropagation()
      event.currentTarget.select()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onFindOpenChange(false)
      return
    }
    if (event.key === 'Enter' || event.key === 'F3') {
      event.preventDefault()
      event.stopPropagation()
      navigateSearch(event.shiftKey ? 'previous' : 'next')
    }
  }

  const searchResultLabel = searchTerm === ''
    ? ''
    : searchResults.resultCount === 0
      ? '0/0'
      : searchResults.resultIndex < 0
        ? `–/${searchResults.resultCount}`
        : `${searchResults.resultIndex + 1}/${searchResults.resultCount}`

  return (
    <div
      className={`dsh-serial-terminal-stage${restoring ? ' is-restoring' : ''}`}
      role="application"
      aria-label="Serial VT terminal"
      aria-busy={restoring}
    >
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
      {findOpen && !restoring && (
        <div className="dsh-serial-find" role="search" aria-label="Find in terminal">
          <input
            ref={searchInputRef}
            type="search"
            value={searchTerm}
            placeholder="Find"
            aria-label="Find text in terminal"
            autoComplete="off"
            spellCheck={false}
            onChange={event => { updateSearchTerm(event.target.value) }}
            onKeyDown={handleSearchKeyDown}
          />
          <output className="dsh-serial-find-count" aria-live="polite">{searchResultLabel}</output>
          <button
            type="button"
            aria-label="Previous match"
            title="Previous match (Shift+Enter)"
            disabled={searchTerm === ''}
            onClick={() => { navigateSearch('previous') }}
          >
            ↑
          </button>
          <button
            type="button"
            aria-label="Next match"
            title="Next match (Enter)"
            disabled={searchTerm === ''}
            onClick={() => { navigateSearch('next') }}
          >
            ↓
          </button>
          <button
            type="button"
            aria-label="Close find"
            title="Close (Escape)"
            onClick={() => { onFindOpenChange(false) }}
          >
            ×
          </button>
        </div>
      )}
      {restoring && <div className="dsh-serial-terminal-restoring">Restoring terminal…</div>}
      {!restoring && events.length === 0 && <div className="dsh-serial-terminal-hint">{emptyLabel}</div>}
    </div>
  )
}

const EMPTY_SEARCH_RESULTS: ISearchResultChangeEvent = {
  resultIndex: -1,
  resultCount: 0,
}

const TERMINAL_SEARCH_DECORATIONS = {
  matchBackground: '#332b18',
  matchBorder: '#8a6d21',
  matchOverviewRuler: '#c99a2e',
  activeMatchBackground: '#5c4718',
  activeMatchBorder: '#ffd166',
  activeMatchColorOverviewRuler: '#ffd166',
} satisfies NonNullable<ISearchOptions['decorations']>

export function runTerminalSearch(
  searchAddon: Pick<SearchAddon, 'findNext' | 'findPrevious'>,
  term: string,
  direction: 'next' | 'previous',
  incremental: boolean,
): void {
  const options: ISearchOptions = {
    caseSensitive: false,
    decorations: TERMINAL_SEARCH_DECORATIONS,
    ...(direction === 'next' ? { incremental } : {}),
  }
  if (direction === 'previous') searchAddon.findPrevious(term, options)
  else searchAddon.findNext(term, options)
}

function clearTerminalSearch(runtime: TerminalRuntime): void {
  runtime.searchAddon.clearDecorations()
  // A serialized checkpoint is written before terminal.open(). xterm's
  // selection service does not exist until then.
  if (runtime.terminal.element !== undefined) runtime.terminal.clearSelection()
}

export function isTerminalFindShortcut(event: {
  readonly key: string
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  readonly altKey: boolean
}): boolean {
  return !event.altKey
    && (event.ctrlKey || event.metaKey)
    && event.key.toLowerCase() === 'f'
}

function drainEvents(
  runtime: TerminalRuntime,
  followRef: { readonly current: boolean },
  setRows: (rows: readonly GutterRow[]) => void,
): void {
  if (!runtime.readyToDrain || runtime.draining || runtime.disposed) return
  const event = runtime.queue.shift()
  if (event === undefined) {
    runtime.completeInitialRestore()
    scheduleCheckpoint(runtime)
    return
  }
  runtime.draining = true
  const refresh = () => { refreshGutter(runtime, setRows) }
  if (event.type === 'rx') {
    const startLine = currentLine(runtime.terminal)
    runtime.processingRxSeq = event.seq
    runtime.terminal.write(decodeBase64(event.dataBase64), () => {
      runtime.processingRxSeq = undefined
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
      runtime.processedThroughSeq = event.seq
      runtime.completeInitialRestore()
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
  runtime.processedThroughSeq = event.seq
  runtime.completeInitialRestore()
  drainEvents(runtime, followRef, setRows)
}

const CHECKPOINT_DELAY_MS = 500
const CHECKPOINT_SCROLLBACK_ROWS = 10_000
const CHECKPOINT_SIGNATURE_ROWS = 8

function scheduleCheckpoint(runtime: TerminalRuntime): void {
  if (runtime.disposed || runtime.restoring || !runtime.checkpointAllowed) return
  if (runtime.checkpointTimer !== undefined) clearTimeout(runtime.checkpointTimer)
  runtime.checkpointTimer = setTimeout(() => {
    runtime.checkpointTimer = undefined
    saveRuntimeCheckpoint(runtime)
  }, CHECKPOINT_DELAY_MS)
}

function saveRuntimeCheckpoint(runtime: TerminalRuntime): void {
  if (runtime.disposed
    || runtime.restoring
    || runtime.draining
    || runtime.queue.length !== 0
    || runtime.processingRxSeq !== undefined
    || !runtime.checkpointAllowed
    || runtime.terminal.buffer.active.type !== 'normal') return
  const existing = runtime.checkpointCache.current
  if (existing?.key === runtime.checkpointKey
    && existing.baseSeq === runtime.checkpointBaseSeq
    && existing.throughSeq === runtime.processedThroughSeq
    && existing.cols === runtime.terminal.cols
    && existing.rows === runtime.terminal.rows) return
  let serializedTerminal: string
  try {
    serializedTerminal = runtime.serializeAddon.serialize({ scrollback: CHECKPOINT_SCROLLBACK_ROWS })
  } catch {
    return
  }
  saveTerminalCheckpoint(runtime.checkpointCache, {
    key: runtime.checkpointKey,
    baseSeq: runtime.checkpointBaseSeq,
    throughSeq: runtime.processedThroughSeq,
    cols: runtime.terminal.cols,
    rows: runtime.terminal.rows,
    payload: {
      serializedTerminal,
      bufferSignature: terminalBufferSignature(runtime.terminal),
      records: runtime.records
        .filter(record => !record.marker.isDisposed)
        .map(record => ({ line: record.marker.line, actor: record.actor })),
      txDrafts: { ...runtime.txDrafts },
      txOpaque: { ...runtime.txOpaque },
      pendingSubmissions: runtime.pendingSubmissions.map(pending => ({ ...pending })),
      receiveTail: runtime.receiveTail.map(span => ({ ...span })),
    },
  })
}

function restoreCheckpointState(
  runtime: TerminalRuntime,
  checkpoint: XtermTerminalCheckpointPayload,
  refresh: () => void,
): void {
  runtime.txDrafts.user = checkpoint.txDrafts.user
  runtime.txDrafts.model = checkpoint.txDrafts.model
  runtime.txOpaque.user = checkpoint.txOpaque.user
  runtime.txOpaque.model = checkpoint.txOpaque.model
  runtime.pendingSubmissions.splice(
    0,
    runtime.pendingSubmissions.length,
    ...checkpoint.pendingSubmissions.map(pending => ({ ...pending })),
  )
  runtime.receiveTail.splice(
    0,
    runtime.receiveTail.length,
    ...checkpoint.receiveTail.map(span => ({ ...span })),
  )
  for (const cached of checkpoint.records) {
    const marker = runtime.terminal.registerMarker(cached.line - currentLine(runtime.terminal)) as IMarker | undefined
    if (marker === undefined) continue
    const record: GutterRecord = { marker, actor: cached.actor }
    runtime.records.push(record)
    marker.onDispose(refresh)
  }
}

function resetCheckpointState(runtime: TerminalRuntime): void {
  for (const record of runtime.records) record.marker.dispose()
  runtime.records.splice(0)
  runtime.queue.splice(0)
  runtime.txDrafts.user = ''
  runtime.txDrafts.model = ''
  runtime.txOpaque.user = false
  runtime.txOpaque.model = false
  runtime.pendingSubmissions.splice(0)
  runtime.receiveTail.splice(0)
  runtime.processingRxSeq = undefined
  runtime.gutterSignature = ''
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

function terminalBufferSignature(terminal: Terminal): string {
  const buffer = terminal.buffer.active
  const start = Math.max(0, buffer.length - CHECKPOINT_SIGNATURE_ROWS)
  const lines = []
  for (let line = start; line < buffer.length; line += 1) {
    const current = buffer.getLine(line)
    lines.push(`${current?.isWrapped === true ? 'w' : 'n'}:${current?.translateToString(false) ?? ''}`)
  }
  return JSON.stringify({
    type: buffer.type,
    cols: terminal.cols,
    rows: terminal.rows,
    baseY: buffer.baseY,
    cursorX: buffer.cursorX,
    cursorY: buffer.cursorY,
    lines,
  })
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
    selectionBackground: requiredVariable(styles, '--serial-terminal-selection-background'),
    selectionForeground: requiredVariable(styles, '--serial-terminal-selection-foreground'),
    selectionInactiveBackground: requiredVariable(styles, '--serial-terminal-selection-inactive'),
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
