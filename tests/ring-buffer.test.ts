import { describe, expect, it } from 'vitest'
import { SequenceRing } from '../src/serial/ring-buffer.js'

describe('SequenceRing', () => {
  it('keeps increasing sequence items and exposes truncation', () => {
    const ring = new SequenceRing<{ seq: number; value: string }>(2)
    ring.push({ seq: 1, value: 'one' })
    ring.push({ seq: 2, value: 'two' })
    ring.push({ seq: 3, value: 'three' })
    expect(ring.after(0, 10)).toEqual({
      earliestSeq: 2,
      truncated: true,
      items: [{ seq: 2, value: 'two' }, { seq: 3, value: 'three' }],
    })
  })

  it('rejects non-monotonic input', () => {
    const ring = new SequenceRing<{ seq: number }>(2)
    ring.push({ seq: 2 })
    expect(() => { ring.push({ seq: 2 }) }).toThrow(/sequence must increase/)
    expect(() => { ring.push({ seq: 1 }) }).toThrow(/sequence must increase/)
  })

  it('preserves sequence gaps and binary-searches in logical order across wraps', () => {
    const ring = new SequenceRing<{ seq: number; value: string }>(4)
    for (const [seq, value] of [
      [10, 'ten'],
      [20, 'twenty'],
      [40, 'forty'],
      [80, 'eighty'],
      [160, 'one-sixty'],
      [320, 'three-twenty'],
    ] as const) ring.push({ seq, value })

    expect(ring.size).toBe(4)
    expect(ring.earliestSeq).toBe(40)
    expect(ring.latestSeq).toBe(320)
    expect(ring.after(39, 10)).toEqual({
      earliestSeq: 40,
      truncated: false,
      items: [
        { seq: 40, value: 'forty' },
        { seq: 80, value: 'eighty' },
        { seq: 160, value: 'one-sixty' },
        { seq: 320, value: 'three-twenty' },
      ],
    })
    expect(ring.after(40, 2)).toEqual({
      earliestSeq: 40,
      truncated: false,
      items: [
        { seq: 80, value: 'eighty' },
        { seq: 160, value: 'one-sixty' },
      ],
    })
    expect(ring.after(81, 10).items).toEqual([
      { seq: 160, value: 'one-sixty' },
      { seq: 320, value: 'three-twenty' },
    ])
    expect(ring.after(320, 10).items).toEqual([])
  })

  it('reports truncation before the retained window and can be cleared and reused', () => {
    const ring = new SequenceRing<{ seq: number }>(3)
    for (const seq of [5, 9, 12, 20]) ring.push({ seq })

    expect(ring.after(7, 3)).toEqual({
      earliestSeq: 9,
      truncated: true,
      items: [{ seq: 9 }, { seq: 12 }, { seq: 20 }],
    })

    ring.clear()
    expect(ring.size).toBe(0)
    expect(ring.earliestSeq).toBeUndefined()
    expect(ring.latestSeq).toBeUndefined()
    expect(ring.after(20, 3)).toEqual({ earliestSeq: 21, truncated: false, items: [] })

    ring.push({ seq: 100 })
    ring.push({ seq: 150 })
    expect(ring.after(100, 3)).toEqual({
      earliestSeq: 100,
      truncated: false,
      items: [{ seq: 150 }],
    })
  })
})
