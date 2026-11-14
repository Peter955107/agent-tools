import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

const PANE = 'auto-continue'
const TITLE = '自動繼續'
const DELAY = 60_000 // type 繼續 one minute after the reset
const status = atom({ plugin: 'auto-continue', key: 'status' } as const, { sessionId: null, nextAt: null })

// $.store keeps the record across restarts; `fired` is the resetsAt already answered.
const K_ID = 'sessionId'
const K_FIRED = 'fired'

let timer: Timer | undefined

const fmt = (ms: number) => new Date(ms).toLocaleString('zh-TW', { hour12: false })

/** Re-reads the record and the 5h reset time, and sets (or clears) the one timer. */
async function arm($: EngineInterface) {
  timer?.cancel()
  timer = undefined
  const saved = ((await $.store.get(K_ID)) as string | undefined) ?? null
  let nextAt: number | null = null

  if (saved !== null && saved === (await $.session.id())) {
    const five = (await $.session.usage()).rateLimits.find(l => l.kind === 'five_hour')
    const reset = five?.resetsAt ? Date.parse(five.resetsAt) : NaN
    if (Number.isFinite(reset) && (await $.store.get(K_FIRED)) !== five!.resetsAt) {
      nextAt = reset + DELAY
      const key = five!.resetsAt
      timer = $.clock.after(Math.max(0, nextAt - (await $.clock.now())), () => void fire($, key!))
    }
  }
  await update($, status, () => ({ sessionId: saved, nextAt }))
}

async function fire($: EngineInterface, resetsAt: string) {
  timer = undefined
  await $.store.set(K_FIRED, resetsAt)
  // One /auto-continue buys one 繼續: clear the record so it never repeats.
  await $.store.delete(K_ID)
  await update($, status, () => ({ sessionId: null, nextAt: null }))
  await $.prompt.submit({ text: '繼續', asUser: true })
}

async function enable($: EngineInterface) {
  await $.store.set(K_ID, await $.session.id())
  await arm($)
  await $.ui.open({ id: PANE, title: TITLE })
}

async function disable($: EngineInterface) {
  await $.store.delete(K_ID)
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
    if ((await read($, status)).sessionId !== null) void $.ui.open({ id: PANE, title: TITLE })
    return ran
  })

  on('command.run', { command: 'auto-continue' }, async ($, e) => {
    if (e.args.trim() === 'off') {
      await disable($)
      return { text: '已停用自動繼續，session 紀錄已清除。' }
    }
    await enable($)
    const s = await read($, status)
    return {
      text: `已記錄 session ${s.sessionId}。` + (s.nextAt ? `將於 ${fmt(s.nextAt)} 輸入「繼續」。` : '尚無 5 小時重置時間，下次回應後排程。'),
    }
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) await arm($)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const s = await read($, status)
    const mine = s.sessionId !== null && s.sessionId === (await $.session.id())

    if (s.sessionId === null) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text dimColor>未啟用。輸入 /auto-continue 記錄此 session。</Text>
          <Button label="啟用" onPress={() => enable($)} />
        </Box>
      )
    }
    return (
      <Box flexDirection="column" gap={1}>
        <Text color="success" bold>
          ● 已啟用程序
        </Text>
        <Text>
          Session：<Text dimColor>{s.sessionId}</Text>
        </Text>
        {!mine ? (
          <Text color="warning">紀錄屬於另一個 session，本 session 不會輸入。</Text>
        ) : s.nextAt !== null ? (
          <Text>下次輸入「繼續」：{fmt(s.nextAt)}</Text>
        ) : (
          <Text dimColor>等待下一次 5 小時重置時間…</Text>
        )}
        <Box gap={1}>
          {!mine && <Button label="改記錄此 session" onPress={() => enable($)} />}
          <Button label="停用" onPress={() => disable($)} />
        </Box>
      </Box>
    )
  })
}
