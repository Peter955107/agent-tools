import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Entry } from '../types'

const PANE = 'auto-continue'
const TITLE = '自動繼續'
const DELAY = 60_000 // type 繼續 one minute after the reset
const POLL = 30_000 // other sessions write the shared file; re-read it this often
const status = atom({ plugin: 'auto-continue', key: 'status' } as const, { sessions: [], self: '' }, { shape: 'multi-1' })

// $.store is per process; `fired` is the resetsAt this session already answered.
const K_FIRED = 'fired'

let timer: Timer | undefined

const fmt = (ms: number) => new Date(ms).toLocaleString('zh-TW', { hour12: false })

/** The file every session shares: the plugin data folder when installed, else beside the mod. */
function file($: EngineInterface): string {
  // shortcut: path derived from the install layout (<config>/plugins/cache/...); revisit if Claude Code exposes a data dir to hooks.
  const [config, rest] = $.plugin.root.split(/[\\/]plugins[\\/]cache[\\/]/)
  return rest !== undefined
    ? `${config}/plugins/data/auto-continue-agent-tools/sessions.json`
    : `${$.plugin.root}/.sessions.json`
}

async function load($: EngineInterface): Promise<Record<string, Entry>> {
  try {
    const data: unknown = JSON.parse(await $.fs.read(file($)))
    return data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, Entry>) : {}
  } catch {
    return {} // missing or unreadable: no sessions recorded
  }
}

/** Read-modify-write of this session's own entry only. */
async function put($: EngineInterface, id: string, entry: Entry | null) {
  const all = await load($)
  if (entry) all[id] = entry
  else delete all[id]
  await $.fs.write(file($), JSON.stringify(all, null, 2))
}

async function sync($: EngineInterface) {
  const all = await load($)
  const self = await $.session.id()
  await update($, status, () => ({
    sessions: Object.values(all).sort((a, b) => (a.nextAt ?? Infinity) - (b.nextAt ?? Infinity)),
    self,
  }))
}

/** Re-reads this session's record and the 5h reset time, and sets (or clears) its one timer. */
async function arm($: EngineInterface) {
  timer?.cancel()
  timer = undefined
  const id = await $.session.id()
  const all = await load($)
  const mine = all[id]

  if (mine) {
    const five = (await $.session.usage()).rateLimits.find(l => l.kind === 'five_hour')
    const resetsAt = five?.resetsAt
    const reset = resetsAt ? Date.parse(resetsAt) : NaN
    let nextAt: number | null = null
    if (resetsAt && Number.isFinite(reset) && (await $.store.get(K_FIRED)) !== resetsAt) {
      nextAt = reset + DELAY
      timer = $.clock.after(Math.max(0, nextAt - (await $.clock.now())), () => void fire($, resetsAt))
    }
    if (nextAt !== mine.nextAt) await put($, id, { ...mine, nextAt })
  }
  await sync($)
}

async function fire($: EngineInterface, resetsAt: string) {
  timer = undefined
  const id = await $.session.id()
  // Another session's pane may have cancelled this one since the timer was set.
  if (!(await load($))[id]) return sync($)
  await $.store.set(K_FIRED, resetsAt)
  // One /auto-continue buys one 繼續: drop this session's record so it never repeats.
  await put($, id, null)
  await sync($)
  await $.prompt.submit({ text: '繼續', asUser: true })
}

async function enable($: EngineInterface) {
  const id = await $.session.id()
  await put($, id, { sessionId: id, root: await $.session.root(), nextAt: null })
  await arm($)
  await $.ui.open({ id: PANE, title: TITLE })
}

async function disable($: EngineInterface, id?: string) {
  await put($, id ?? (await $.session.id()), null)
  await arm($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const ran = await next(e)
    await $.command.register({
      name: 'auto-continue',
      description: '記錄此 session，5 小時用量重置 1 分鐘後輸入一次「繼續」（off 取消）',
      immediate: true,
    })
    await arm($)
    $.clock.every(POLL, () => void sync($))
    const s = await read($, status)
    if (s.sessions.some(x => x.sessionId === s.self)) void $.ui.open({ id: PANE, title: TITLE })
    return ran
  })

  on('command.run', { command: 'auto-continue' }, async ($, e) => {
    if (e.args.trim() === 'off') {
      await disable($)
      return { text: '已取消本 session 的自動繼續。' }
    }
    await enable($)
    const s = await read($, status)
    const me = s.sessions.find(x => x.sessionId === s.self)
    return {
      text:
        `已記錄 session ${s.self}。` +
        (me?.nextAt ? `將於 ${fmt(me.nextAt)} 輸入一次「繼續」。` : '尚無 5 小時重置時間，下次回應後排程。'),
    }
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) await arm($)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const { sessions, self } = await read($, status)
    const isMine = sessions.some(x => x.sessionId === self)

    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>將被呼叫「繼續」的 session（{sessions.length}）</Text>
        {sessions.length === 0 && <Text dimColor>目前沒有。輸入 /auto-continue 記錄此 session。</Text>}
        {sessions.map(x => (
          <Box key={x.sessionId} flexDirection="column">
            <Text>
              <Text color="success">● </Text>
              {x.sessionId.slice(0, 8)}
              {x.sessionId === self && <Text color="success"> （本 session）</Text>}
              <Text dimColor>  {x.root}</Text>
            </Text>
            <Box gap={1} paddingLeft={2}>
              <Text dimColor>{x.nextAt !== null ? `${fmt(x.nextAt)} 輸入「繼續」` : '等待 5 小時重置時間…'}</Text>
              <Button key={`off-${x.sessionId}`} label="取消" plain dimColor onPress={() => disable($, x.sessionId)} />
            </Box>
          </Box>
        ))}
        <Box gap={1}>
          {!isMine && <Button key="on" label="記錄此 session" onPress={() => enable($)} />}
          <Button key="reload" label="重新整理" plain dimColor onPress={() => sync($)} />
        </Box>
      </Box>
    )
  })
}
