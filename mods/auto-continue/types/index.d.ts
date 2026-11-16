/** One recorded session: where it runs, when 繼續 is typed (null: no reset time yet), and whether its last turn hit the usage limit. */
export type Entry = { sessionId: string; root: string; nextAt: number | null; limited?: boolean }
/** What the pane shows: every recorded session, read from the shared file. */
export type Status = { sessions: Entry[]; self: string }

declare module 'claude-code' {
  interface PluginState {
    'auto-continue': { status: Shaped<Status> }
  }
}
