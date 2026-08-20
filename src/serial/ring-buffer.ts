/** Fixed-capacity circular sequence buffer used for reconnectable polling. */

export interface SequenceItem {
  readonly seq: number
}

export interface SequenceSlice<T> {
  readonly earliestSeq: number
  readonly truncated: boolean
  readonly items: readonly T[]
}

export class SequenceRing<T extends SequenceItem> {
  private readonly values: Array<T | undefined>
  private head = 0
  private count = 0

  constructor(readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new TypeError('ring capacity must be a positive safe integer')
    }
    this.values = new Array<T | undefined>(capacity)
  }

  get size(): number {
    return this.count
  }

  get earliestSeq(): number | undefined {
    return this.count === 0 ? undefined : this.valueAt(0).seq
  }

  get latestSeq(): number | undefined {
    return this.count === 0 ? undefined : this.valueAt(this.count - 1).seq
  }

  push(value: T): void {
    const latest = this.latestSeq
    if (latest !== undefined && value.seq <= latest) {
      throw new Error(`sequence must increase: ${value.seq} <= ${latest}`)
    }
    if (this.count < this.capacity) {
      this.values[this.physicalIndex(this.count)] = value
      this.count += 1
      return
    }
    this.values[this.head] = value
    this.head = (this.head + 1) % this.capacity
  }

  clear(): void {
    for (let offset = 0; offset < this.count; offset += 1) {
      this.values[this.physicalIndex(offset)] = undefined
    }
    this.head = 0
    this.count = 0
  }

  after(afterSeq: number, limit: number): SequenceSlice<T> {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
      throw new TypeError('afterSeq must be a non-negative safe integer')
    }
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new TypeError('limit must be a positive safe integer')
    }
    const earliestSeq = this.earliestSeq ?? afterSeq + 1
    const truncated = this.count > 0 && afterSeq < earliestSeq - 1
    const start = this.upperBound(afterSeq)
    const itemCount = Math.min(limit, this.count - start)
    const items = new Array<T>(itemCount)
    for (let offset = 0; offset < itemCount; offset += 1) {
      items[offset] = this.valueAt(start + offset)
    }
    return { earliestSeq, truncated, items }
  }

  /** First logical offset whose sequence is greater than the requested cursor. */
  private upperBound(afterSeq: number): number {
    let low = 0
    let high = this.count
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2)
      if (this.valueAt(middle).seq <= afterSeq) low = middle + 1
      else high = middle
    }
    return low
  }

  private valueAt(logicalIndex: number): T {
    const value = this.values[this.physicalIndex(logicalIndex)]
    if (value === undefined) throw new Error('ring storage invariant violated')
    return value
  }

  private physicalIndex(logicalIndex: number): number {
    return (this.head + logicalIndex) % this.capacity
  }
}
