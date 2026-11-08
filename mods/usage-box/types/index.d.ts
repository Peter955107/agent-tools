export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type Snapshot = { limits: Limit[]; contextPercent: number | null }
/** pill: band hidden, figures in the status line; row: the meters. 'full' is a retired value read as row. */
export type Mode = 'pill' | 'row' | 'full'

declare module 'claude-code' {
  interface PluginState {
    'usage-box': { snap: Shaped<Snapshot>; warned: string[]; mode: Mode }
  }
}
