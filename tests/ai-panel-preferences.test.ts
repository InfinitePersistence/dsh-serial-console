import { describe, expect, it } from 'vitest'
import {
  clampAiPanelWidth,
  loadAiPanelPreferences,
  saveAiPanelPreferences,
} from '../src/client/ai-panel-preferences.js'

describe('AI panel preferences', () => {
  it('uses an open desktop panel and a closed narrow-screen panel by default', () => {
    expect(loadAiPanelPreferences(undefined, 1_200)).toEqual({ open: true, width: 380 })
    expect(loadAiPanelPreferences(undefined, 700)).toEqual({ open: false, width: 380 })
  })

  it('clamps stored and dragged widths to the supported range', () => {
    expect(clampAiPanelWidth(120)).toBe(300)
    expect(clampAiPanelWidth(481.6)).toBe(482)
    expect(clampAiPanelWidth(900)).toBe(600)
  })

  it('round-trips only visibility and bounded width', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
    }

    saveAiPanelPreferences({ open: false, width: 900 }, storage)

    expect(loadAiPanelPreferences(storage, 1_200)).toEqual({ open: false, width: 600 })
  })
})
