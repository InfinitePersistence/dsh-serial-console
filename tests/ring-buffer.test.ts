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
  })
})

