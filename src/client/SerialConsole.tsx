import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import type { SerialEvent } from '../protocol.js'
import { AiActivityPanel } from './AiActivityPanel.js'
import { deriveAiActivity } from './ai-activity.js'
import type { AiActivitySnapshot, SerialConversationSnapshot, UseSerialConversation } from './ai-activity.js'
import {
  clampAiPanelWidth,
  loadAiPanelPreferences,
  saveAiPanelPreferences,
} from './ai-panel-preferences.js'
import type { SerialConsoleStore, SerialLineEnding } from './serial-console-store.js'
import { XtermSerialTerminal } from './XtermSerialTerminal.js'
import type { XtermTerminalCheckpointPayload } from './XtermSerialTerminal.js'
import { createTerminalCheckpointCache } from './terminal-checkpoint.js'
import type { TerminalCheckpointCache } from './terminal-checkpoint.js'
import './serial-console.css'

/** Props for the standalone serial-console surface. */
export interface SerialConsoleProps {
  readonly store: SerialConsoleStore
  /** DSH session selector hook; omitted when embedding the standalone React surface. */
  readonly useConversation?: UseSerialConversation
}

interface SerialConsoleUiMemory {
  hiddenBeforeSeq: number
  readonly checkpointCache: TerminalCheckpointCache<XtermTerminalCheckpointPayload>
}

const UI_MEMORY = new WeakMap<SerialConsoleStore, SerialConsoleUiMemory>()

/** Standalone serial console combining xterm with Host connection controls. */
export function SerialConsole({ store, useConversation }: SerialConsoleProps) {
  if (useConversation === undefined) return <SerialConsoleSurface store={store} />
  return <ConversationAwareSerialConsole store={store} useConversation={useConversation} />
}

function ConversationAwareSerialConsole({
  store,
  useConversation,
}: Required<SerialConsoleProps>) {
  const conversation = useConversation(selectConversation)
  const activity = useMemo(() => deriveAiActivity(conversation), [conversation])
  return <SerialConsoleSurface store={store} aiActivity={activity} />
}

function selectConversation(snapshot: SerialConversationSnapshot): SerialConversationSnapshot {
  return snapshot
}

function SerialConsoleSurface({
  store,
  aiActivity,
}: {
  readonly store: SerialConsoleStore
  readonly aiActivity?: AiActivitySnapshot
}) {
  const uiMemory = useMemo(() => memoryFor(store), [store])
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const [mode, setMode] = useState<'text' | 'hex'>('text')
  const [follow, setFollow] = useState(true)
  const [hiddenBeforeSeq, setHiddenBeforeSeq] = useState(uiMemory.hiddenBeforeSeq)
  const [aiPanel, setAiPanel] = useState(loadAiPanelPreferences)
  const [aiUnread, setAiUnread] = useState(false)
  const workbenchRef = useRef<HTMLDivElement>(null)
  const panelWidthRef = useRef(aiPanel.width)
  const dragRef = useRef<{ readonly pointerId: number; readonly startX: number; readonly startWidth: number }>()
  const pendingWidthRef = useRef<number>()
  const resizeFrameRef = useRef<number>()
  const activitySignatureRef = useRef(aiActivity?.signature)

  useEffect(() => {
    const stop = store.start()
    void store.loadPorts()
    return stop
  }, [store])

  useEffect(() => () => {
    if (resizeFrameRef.current !== undefined) cancelAnimationFrame(resizeFrameRef.current)
  }, [])

  useEffect(() => {
    if (aiActivity === undefined || aiActivity.signature === activitySignatureRef.current) return
    activitySignatureRef.current = aiActivity.signature
    if (aiPanel.open) setAiUnread(false)
    else if (aiActivity.status !== 'idle') setAiUnread(true)
  }, [aiActivity, aiPanel.open])

  const visibleEvents = useMemo(
    () => state.events.filter(event => event.seq > hiddenBeforeSeq).slice(-2_000),
    [hiddenBeforeSeq, state.events],
  )
  const connected = state.remote.status === 'connected'
  const busy = state.remote.status === 'opening' || state.remote.status === 'closing'
  const synchronizationStopped = state.syncFault !== undefined
  const disconnectAvailable = connected
    || (synchronizationStopped && state.remote.status !== 'disconnected')
  const terminalInputEnabled = connected && !synchronizationStopped
  const synchronizationError = state.syncFault ?? state.syncError
  const checkpointKey = `${state.remote.sessionId ?? 'disconnected'}:${hiddenBeforeSeq}`

  const toggleConnection = async () => {
    if (disconnectAvailable) {
      await store.disconnect()
      return
    }
    const parsedBaud = Number(state.baudRate)
    if (state.selectedPath === '' || !Number.isSafeInteger(parsedBaud) || parsedBaud < 1) return
    await store.connect({ path: state.selectedPath, baudRate: parsedBaud })
  }

  const setAiPanelOpen = (open: boolean) => {
    const next = { ...aiPanel, open }
    setAiPanel(next)
    saveAiPanelPreferences(next)
    if (open) setAiUnread(false)
  }

  const commitPanelWidth = (width: number) => {
    const next = { ...aiPanel, width: clampAiPanelWidth(width) }
    panelWidthRef.current = next.width
    setAiPanel(next)
    saveAiPanelPreferences(next)
  }

  const schedulePanelWidth = (width: number) => {
    const next = clampAiPanelWidth(width)
    pendingWidthRef.current = next
    panelWidthRef.current = next
    if (resizeFrameRef.current !== undefined) return
    resizeFrameRef.current = requestAnimationFrame(() => {
      resizeFrameRef.current = undefined
      const pending = pendingWidthRef.current
      if (pending !== undefined) {
        workbenchRef.current?.style.setProperty('--dsh-serial-ai-width', `${pending}px`)
      }
    })
  }

  const beginPanelResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: panelWidthRef.current,
    }
  }

  const resizePanel = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (drag === undefined || drag.pointerId !== event.pointerId) return
    schedulePanelWidth(drag.startWidth + drag.startX - event.clientX)
  }

  const finishPanelResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (drag === undefined || drag.pointerId !== event.pointerId) return
    dragRef.current = undefined
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    commitPanelWidth(pendingWidthRef.current ?? panelWidthRef.current)
    pendingWidthRef.current = undefined
  }

  const resizePanelByKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    commitPanelWidth(panelWidthRef.current + (event.key === 'ArrowLeft' ? 16 : -16))
  }

  const workbenchStyle = {
    '--dsh-serial-ai-width': `${aiPanel.width}px`,
  } as CSSProperties

  const terminal = mode === 'text' ? (
    <XtermSerialTerminal
      key={checkpointKey}
      events={visibleEvents}
      connected={terminalInputEnabled}
      follow={follow}
      lineEnding={state.lineEnding}
      checkpointKey={checkpointKey}
      checkpointBaseSeq={hiddenBeforeSeq}
      checkpointAllowed={!state.gapDetected}
      checkpointCache={uiMemory.checkpointCache}
      emptyLabel={synchronizationStopped
        ? 'Serial synchronization stopped. Disconnect or reload the Remote plugin to recover.'
        : connected
          ? 'Connected: Tab, arrows, paste, and terminal controls are sent directly to the board.'
          : 'Select a serial port and baud rate, then connect.'}
      onTextInput={text => store.sendTerminalText(text)}
      onBinaryInput={dataBase64 => store.sendTerminalBinary(dataBase64)}
    />
  ) : (
    <div className="dsh-serial-hex-log" role="log" aria-label="Raw serial byte events">
      {visibleEvents.map(event => <HexRow key={`${event.sessionId}:${event.seq}`} event={event} />)}
    </div>
  )

  return (
    <section className="dsh-serial-console" aria-label="Serial Console">
      <header className="dsh-serial-toolbar">
        <span className={`dsh-serial-status is-${state.remote.status}`} aria-label={state.remote.status} />
        <select
          aria-label="Serial port"
          value={state.selectedPath}
          disabled={connected || busy}
          onChange={event => { store.setSelectedPath(event.target.value) }}
        >
          {state.ports.length === 0 && <option value="">No serial ports</option>}
          {state.ports.map(port => (
            <option key={`${port.path}:${port.serialNumber ?? ''}`} value={port.path}>
              {port.friendlyName === undefined ? port.path : `${port.path} — ${port.friendlyName}`}
            </option>
          ))}
        </select>
        <input
          aria-label="Baud rate"
          className="dsh-serial-baud"
          value={state.baudRate}
          disabled={connected || busy}
          inputMode="numeric"
          onChange={event => { store.setBaudRate(event.target.value) }}
        />
        <button
          type="button"
          disabled={disconnectAvailable
            ? busy && !synchronizationStopped
            : busy || state.selectedPath === '' || synchronizationStopped}
          onClick={() => { void toggleConnection() }}
        >
          {disconnectAvailable ? 'Disconnect' : busy ? state.remote.status : 'Connect'}
        </button>
        <select
          aria-label="Line ending"
          value={state.lineEnding}
          disabled={!terminalInputEnabled}
          title="Bytes sent by the physical Enter key"
          onChange={event => { store.setLineEnding(event.target.value as SerialLineEnding) }}
        >
          <option value="cr">CR</option>
          <option value="crlf">CRLF</option>
          <option value="lf">LF</option>
          <option value="none">None</option>
        </select>
        <button type="button" onClick={() => { setFollow(value => !value) }} aria-pressed={follow}>
          Follow {follow ? '✓' : '–'}
        </button>
        <button type="button" onClick={() => { setMode(value => value === 'text' ? 'hex' : 'text') }}>
          {mode.toUpperCase()}
        </button>
        <button
          type="button"
          onClick={() => {
            const next = state.events.at(-1)?.seq ?? hiddenBeforeSeq
            uiMemory.hiddenBeforeSeq = next
            uiMemory.checkpointCache.current = undefined
            setHiddenBeforeSeq(next)
          }}
          title="Only clears this terminal; Host audit logs are retained"
        >
          Clear view
        </button>
        <button type="button" onClick={() => { downloadEvents(state.events) }}>Export</button>
        {aiActivity !== undefined && (
          <button
            type="button"
            className="dsh-serial-ai-toggle"
            onClick={() => { setAiPanelOpen(!aiPanel.open) }}
            aria-expanded={aiPanel.open}
            aria-controls="dsh-serial-ai-panel"
          >
            AI {aiPanel.open ? '✓' : '–'}
            {aiUnread && <span className="dsh-serial-ai-unread" aria-label="New AI activity" />}
          </button>
        )}
      </header>

      {state.gapDetected && (
        <div className="dsh-serial-warning">Some in-memory events expired. Export the Host audit log for complete evidence.</div>
      )}
      {synchronizationError !== undefined && <div className="dsh-serial-error">{synchronizationError}</div>}
      {state.lastError !== undefined && <div className="dsh-serial-error">{state.lastError}</div>}

      <div
        ref={workbenchRef}
        className={`dsh-serial-workbench${aiPanel.open && aiActivity !== undefined ? ' is-ai-open' : ''}`}
        style={workbenchStyle}
      >
        <div className="dsh-serial-terminal-pane">{terminal}</div>
        {aiPanel.open && aiActivity !== undefined && (
          <>
            <div
              className="dsh-serial-ai-resizer"
              role="separator"
              aria-label="Resize AI activity panel"
              aria-orientation="vertical"
              aria-valuemin={300}
              aria-valuemax={600}
              aria-valuenow={aiPanel.width}
              tabIndex={0}
              onPointerDown={beginPanelResize}
              onPointerMove={resizePanel}
              onPointerUp={finishPanelResize}
              onPointerCancel={finishPanelResize}
              onKeyDown={resizePanelByKeyboard}
            />
            <div id="dsh-serial-ai-panel" className="dsh-serial-ai-panel-seat">
              <AiActivityPanel activity={aiActivity} onClose={() => { setAiPanelOpen(false) }} />
            </div>
          </>
        )}
      </div>
    </section>
  )
}

function memoryFor(store: SerialConsoleStore): SerialConsoleUiMemory {
  const existing = UI_MEMORY.get(store)
  if (existing !== undefined) return existing
  const created: SerialConsoleUiMemory = {
    hiddenBeforeSeq: 0,
    checkpointCache: createTerminalCheckpointCache<XtermTerminalCheckpointPayload>(),
  }
  UI_MEMORY.set(store, created)
  return created
}

function HexRow({ event }: { event: SerialEvent }) {
  const time = new Date(event.timestamp).toLocaleTimeString(undefined, { hour12: false })
  if (event.type === 'rx') {
    return (
      <div className="dsh-serial-row is-rx">
        <time>{time}</time><Actor actor="board" /><span>{hexBytes(event.dataBase64)}</span>
      </div>
    )
  }
  if (event.type === 'tx') {
    return (
      <div className={`dsh-serial-row is-${event.actor}`} title={event.toolCallId}>
        <time>{time}</time><Actor actor={event.actor} /><span>{hexBytes(event.dataBase64)}</span>
      </div>
    )
  }
  if (event.type === 'marker') {
    return (
      <div className="dsh-serial-row is-system">
        <time>{time}</time><Actor actor={event.actor} /><span>── {event.label} ──</span>
      </div>
    )
  }
  if (event.type === 'error') {
    return (
      <div className="dsh-serial-row is-error">
        <time>{time}</time><Actor actor="system" /><span>{event.code}: {event.message}</span>
      </div>
    )
  }
  return (
    <div className="dsh-serial-row is-system">
      <time>{time}</time><Actor actor="system" />
      <span>{event.status}{event.message === undefined ? '' : ` — ${event.message}`}</span>
    </div>
  )
}

function Actor({ actor }: { actor: 'board' | 'model' | 'user' | 'system' }) {
  return <span className={`dsh-serial-actor is-${actor}`}>{actor.toUpperCase()}</span>
}

function hexBytes(dataBase64: string): string {
  return decodeBase64(dataBase64).map(byte => byte.toString(16).padStart(2, '0')).join(' ')
}

function decodeBase64(value: string): number[] {
  return [...globalThis.atob(value)].map(character => character.charCodeAt(0))
}

function downloadEvents(events: readonly SerialEvent[]): void {
  const body = events.map(event => JSON.stringify(event)).join('\n')
  const url = URL.createObjectURL(new Blob([body, body.length === 0 ? '' : '\n'], { type: 'application/x-ndjson' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `serial-console-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`
  anchor.click()
  URL.revokeObjectURL(url)
}
