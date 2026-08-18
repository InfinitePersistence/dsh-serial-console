/** Fixed-capacity sequence buffer used for reconnectable polling. */

export interface SequenceItem {
  readonly seq: number
}

export interface SequenceSlice<T> {
  readonly earliestSeq: number
  readonly truncated: boolean
  readonly items: readonly T[]
}

export class SequenceRing<T extends SequenceItem> {
  private readonly values: T[] = []

  constructor(readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new TypeError('ring capacity must be a positive safe integer')
    }
  }

  get size(): number {
    return this.values.length
  }

  get earliestSeq(): number | undefined {
    return this.values[0]?.seq
  }

  get latestSeq(): number | undefined {
    return this.values.at(-1)?.seq
  }

  push(value: T): void {
    const latest = this.latestSeq
    if (latest !== undefined && value.seq <= latest) {
      throw new Error(`sequence must increase: ${value.seq} <= ${latest}`)
    }
    this.values.push(value)
    if (this.values.length > this.capacity) this.values.splice(0, this.values.length - this.capacity)
  }

  clear(): void {
    this.values.length = 0
  }

  after(afterSeq: number, limit: number): SequenceSlice<T> {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
      throw new TypeError('afterSeq must be a non-negative safe integer')
    }
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new TypeError('limit must be a positive safe integer')
    }
    const earliestSeq = this.earliestSeq ?? afterSeq + 1
    const truncated = this.values.length > 0 && afterSeq < earliestSeq - 1
    const start = this.values.findIndex(value => value.seq > afterSeq)
    const items = start === -1 ? [] : this.values.slice(start, start + limit)
    return { earliestSeq, truncated, items }
  }
}
