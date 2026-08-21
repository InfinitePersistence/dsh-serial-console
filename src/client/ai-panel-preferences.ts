export const DEFAULT_AI_PANEL_WIDTH = 380
export const MIN_AI_PANEL_WIDTH = 300
export const MAX_AI_PANEL_WIDTH = 600

const STORAGE_KEY = '@infinitepersistence/dsh-serial-console/ai-panel'

export interface AiPanelPreferences {
  readonly open: boolean
  readonly width: number
}

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export function clampAiPanelWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_AI_PANEL_WIDTH
  return Math.min(MAX_AI_PANEL_WIDTH, Math.max(MIN_AI_PANEL_WIDTH, Math.round(width)))
}

export function loadAiPanelPreferences(
  storage = browserStorage(),
  viewportWidth = browserViewportWidth(),
): AiPanelPreferences {
  const fallback = {
    open: viewportWidth >= 900,
    width: DEFAULT_AI_PANEL_WIDTH,
  }
  if (storage === undefined) return fallback
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (raw === null) return fallback
    const parsed = JSON.parse(raw) as { open?: unknown; width?: unknown }
    return {
      open: typeof parsed.open === 'boolean' ? parsed.open : fallback.open,
      width: typeof parsed.width === 'number'
        ? clampAiPanelWidth(parsed.width)
        : fallback.width,
    }
  } catch {
    return fallback
  }
}

export function saveAiPanelPreferences(
  preferences: AiPanelPreferences,
  storage = browserStorage(),
): void {
  if (storage === undefined) return
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({
      open: preferences.open,
      width: clampAiPanelWidth(preferences.width),
    }))
  } catch {
    // Storage may be denied by browser privacy policy; UI state still works in memory.
  }
}

function browserStorage(): StorageLike | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    return undefined
  }
}

function browserViewportWidth(): number {
  return typeof window === 'undefined' ? 1_024 : window.innerWidth
}
