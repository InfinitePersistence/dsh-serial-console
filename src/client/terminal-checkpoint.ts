import type { SerialEvent } from '../protocol.js'

/** One in-memory xterm checkpoint owned by a browser-side console generation. */
export interface TerminalCheckpoint<TPayload> {
  readonly key: string
  readonly baseSeq: number
  readonly throughSeq: number
  readonly cols: number
  readonly rows: number
  readonly payload: TPayload
}

/** Mutable cache container that can survive a React view unmount. */
export interface TerminalCheckpointCache<TPayload> {
  current: TerminalCheckpoint<TPayload> | undefined
}

export interface TerminalCheckpointLookup {
  readonly key: string
  readonly baseSeq: number
  readonly events: readonly SerialEvent[]
  readonly allowRestore: boolean
}

export function createTerminalCheckpointCache<TPayload>(): TerminalCheckpointCache<TPayload> {
  return { current: undefined }
}

/**
 * Return a checkpoint only when the retained event window can continue it
 * without a session, clear-view, rewind, or truncation gap.
 */
export function takeRestorableTerminalCheckpoint<TPayload>(
  cache: TerminalCheckpointCache<TPayload>,
  lookup: TerminalCheckpointLookup,
): TerminalCheckpoint<TPayload> | undefined {
  const checkpoint = cache.current
  if (checkpoint === undefined) return undefined
  if (!lookup.allowRestore
    || checkpoint.key !== lookup.key
    || checkpoint.baseSeq !== lookup.baseSeq
    || checkpoint.throughSeq < lookup.baseSeq) {
    cache.current = undefined
    return undefined
  }

  const lastSeq = lookup.events.at(-1)?.seq
  if (lastSeq !== undefined && lastSeq < checkpoint.throughSeq) {
    cache.current = undefined
    return undefined
  }
  let expectedSeq = checkpoint.throughSeq + 1
  for (const event of lookup.events) {
    if (event.seq <= checkpoint.throughSeq) continue
    if (event.seq !== expectedSeq) {
      cache.current = undefined
      return undefined
    }
    expectedSeq += 1
  }
  return checkpoint
}

export function saveTerminalCheckpoint<TPayload>(
  cache: TerminalCheckpointCache<TPayload>,
  checkpoint: TerminalCheckpoint<TPayload>,
): void {
  cache.current = checkpoint
}
