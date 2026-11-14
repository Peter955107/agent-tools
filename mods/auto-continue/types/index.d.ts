/** One recorded session: where it runs and when 繼續 is typed (null: no reset time yet). */
export type Entry = { sessionId: string; root: string; nextAt: number | null }
/** What the pane shows: every recorded session, read from the shared file. */
export type Status = { sessions: Entry[]; self: string }

declare module 'claude-code' {
  interface PluginState {
    'auto-continue': { status: Shaped<Status> }
  }
}
