import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('AI activity Markdown palette', () => {
  it('keeps DSH Markdown readable on the always-dark serial panel', () => {
    const css = readFileSync(
      new URL('../src/client/serial-console.css', import.meta.url),
      'utf8',
    )
    const panelRule = css.match(/\.dsh-serial-ai-panel \{(?<body>[\s\S]*?)\n\}/)?.groups?.body

    expect(panelRule).toContain('--dsw-alias-label-primary: var(--serial-fg)')
    expect(panelRule).toContain('--dsw-alias-markdown-inline-code: #1b2632')
    expect(panelRule).toContain('--shiki-token-punctuation: #ced4da')
  })
})
