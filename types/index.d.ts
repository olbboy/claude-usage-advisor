export type Fix = { type: 'prompt' | 'compact'; text: string }

export type Row = {
  id: string
  kind: string
  label: string
  detail: string
  fix: Fix
  sharePct: number
  isMain: boolean
  weightedLabel: string
}

export type Report = {
  generatedAt: string
  days: number
  totalLabel: string
  requests: number
  tookMs: number
  rows: Row[]
}

export type Scan = {
  days: 1 | 7
  isRunning: boolean
  error: string | null
  week: Report | null
  day: Report | null
  sent: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'usage-advisor': { scan: Shaped<Scan> }
  }
}
