/** What the pane shows: the recorded session and when 繼續 is next typed. */
export type Status = { sessionId: string | null; nextAt: number | null }

declare module 'claude-code' {
  interface PluginState {
    'auto-continue': { status: Status }
  }
}
