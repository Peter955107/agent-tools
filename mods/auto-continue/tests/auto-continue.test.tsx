import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Entry } from '../types'

const T0 = Date.parse('2026-11-16T10:00:00Z')
const HOUR = 3_600_000
const R1 = new Date(T0 + HOUR).toISOString()
const R2 = new Date(T0 + 6 * HOUR).toISOString()
const ID = 'S1'

/** The engine beneath the mod: an in-memory disk, one session, its 5h window, and a log of submitted prompts. */
function world(on: On) {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on)
  const files = new Map<string, string>()
  const submits: { text: string; plugin: boolean }[] = []
  const limits = { resetsAt: R1 }
  const usage = () => ({
    startedAt: T0,
    context: { window: 200_000 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 100, resetsAt: limits.resetsAt }],
  })

  on('fs.read', (_, e) => ({ value: files.get(e.path) ?? '{}' }))
  on('fs.write', (_, e) => (files.set(e.path, e.text), { value: undefined }))
  on('session.id', () => ({ value: ID }))
  on('session.root', () => ({ value: '/proj' }))
  on('session.usage', () => ({ value: usage() }))
  on('command.register', () => ({ value: { command: 'auto-continue' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('classic.StopFailure', () => ({}))
  on('prompt.submit', (_, e) => {
    submits.push({ text: e.text, plugin: (e as { origin?: { kind: string } }).origin?.kind === 'plugin' })
    return { text: e.text }
  })

  const sessions = (): Record<string, Entry> => {
    const all = [...files.values()]
    return all.length ? JSON.parse(all[0]!) : {}
  }
  const continues = () => submits.filter(s => s.text === '繼續')
  return { clock, files, submits, continues, sessions, limits, usage }
}

type World = ReturnType<typeof world>

async function start($: Engine) {
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
}

const record = ($: Engine, args = '') => $.command.run({ command: 'auto-continue', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
const stop = ($: Engine, error: Parameters<Engine["classic"]["StopFailure"]>[0]["error"]) => $.classic.StopFailure({ error })
/** Past reset + 60 s. */
const pastReset = (w: World, resetsAt: string) => w.clock.set(Date.parse(resetsAt) + 60_000 + 1_000)

test('1. recorded + rate_limit stop: one 繼續 at reset+60s, entry removed', async ($, on) => {
  const w = world(on)
  await start($)
  await record($)
  expect(w.sessions()[ID]?.nextAt).toBe(Date.parse(R1) + 60_000)
  await stop($, 'rate_limit')
  expect(w.sessions()[ID]?.limited).toBe(true)

  await w.clock.set(Date.parse(R1) + 59_000)
  expect(w.continues().length).toBe(0)

  await pastReset(w, R1)
  expect(w.continues().length).toBe(1)
  expect(w.continues()[0]!.plugin).toBe(true)
  expect(w.sessions()[ID]).toBeUndefined()
})

test('2. recorded, no stop: reset passes, nothing submitted, entry stays', async ($, on) => {
  const w = world(on)
  await start($)
  await record($)
  await pastReset(w, R1)
  expect(w.submits.length).toBe(0)
  expect(w.sessions()[ID]).toBeDefined()
  expect(w.sessions()[ID]?.nextAt).toBe(null)
})

for (const error of ['overloaded', 'server_error', 'unknown'] as const) {
  test(`3. recorded + ${error} stop: nothing submitted`, async ($, on) => {
    const w = world(on)
    await start($)
    await record($)
    await stop($, error)
    expect(w.sessions()[ID]?.limited).toBeFalsy()
    await pastReset(w, R1)
    expect(w.submits.length).toBe(0)
    expect(w.sessions()[ID]).toBeDefined()
  })
}

test('4. rate_limit stop then user prompt: flag cleared, nothing submitted', async ($, on) => {
  const w = world(on)
  await start($)
  await record($)
  await stop($, 'rate_limit')
  await $.prompt.submit({ text: 'hello', wait: false, origin: { kind: 'composer' } })
  expect(w.sessions()[ID]?.limited).toBe(false)
  await pastReset(w, R1)
  expect(w.continues().length).toBe(0)
  expect(w.sessions()[ID]).toBeDefined()
})

test('5. not recorded + rate_limit stop: nothing submitted, no entry', async ($, on) => {
  const w = world(on)
  await start($)
  await stop($, 'rate_limit')
  await pastReset(w, R1)
  expect(w.submits.length).toBe(0)
  expect(w.sessions()[ID]).toBeUndefined()
})

test('6. /auto-continue off after limited: nothing submitted', async ($, on) => {
  const w = world(on)
  await start($)
  await record($)
  await stop($, 'rate_limit')
  await record($, 'off')
  expect(w.sessions()[ID]).toBeUndefined()
  await pastReset(w, R1)
  expect(w.submits.length).toBe(0)
})

test('7. not limited at first reset, stays armed: next window + rate_limit fires', async ($, on) => {
  const w = world(on)
  await start($)
  await record($)
  await pastReset(w, R1)
  expect(w.submits.length).toBe(0)
  expect(w.sessions()[ID]?.nextAt).toBe(null)

  w.limits.resetsAt = R2
  await $.session.measure({ ...w.usage(), changed: ['rateLimits'] })
  expect(w.sessions()[ID]?.nextAt).toBe(Date.parse(R2) + 60_000)

  await stop($, 'rate_limit')
  await pastReset(w, R2)
  expect(w.continues().length).toBe(1)
  expect(w.sessions()[ID]).toBeUndefined()
})

test('8. fires only once as time keeps passing', async ($, on) => {
  const w = world(on)
  await start($)
  await record($)
  await stop($, 'rate_limit')
  await pastReset(w, R1)
  expect(w.continues().length).toBe(1)

  await w.clock.advance(10 * HOUR)
  await $.session.measure({ ...w.usage(), changed: ['rateLimits'] })
  await w.clock.advance(HOUR)
  expect(w.continues().length).toBe(1)
  expect(w.submits.length).toBe(1)
})

test('9. rate_limit stop first, /auto-continue after: still fires', async ($, on) => {
  const w = world(on)
  await start($)
  await stop($, 'rate_limit')
  await record($)
  expect(w.sessions()[ID]?.limited).toBe(true)
  await pastReset(w, R1)
  expect(w.continues().length).toBe(1)
  expect(w.sessions()[ID]).toBeUndefined()
})

test('10. a slash command submission does not clear the limit flag', async ($, on) => {
  const w = world(on)
  await start($)
  await record($)
  await stop($, 'rate_limit')
  await $.prompt.submit({ text: '/usage', wait: false, origin: { kind: 'composer' }, command: { name: 'usage', args: '' } })
  expect(w.sessions()[ID]?.limited).toBe(true)
  await pastReset(w, R1)
  expect(w.continues().length).toBe(1)
})

/** Settings PreToolUse hook beneath that denies every tool call with `reason`; register before the first $ call. */
function denyBeneath(on: On, reason: string) {
  on('classic.PreToolUse', () => ({ deny: reason }))
  on('tool.call', () => ({ deny: 'unreached' }))
}
const call = ($: Engine) => $.tool.call({ tool: 'Bash', command: 'ls' })

test('11. usage-sentinel stop deny when stopped.json is unreachable (not installed): not limited', async ($, on) => {
  denyBeneath(on, 'usage-sentinel：用量 93%，由使用者選擇停止。只允許 git add／git commit 與編輯 RESUME.md，完成後結束回覆')
  const w = world(on)
  await start($)
  await record($)
  const r = await call($)
  expect(r.isError).toBe(true)
  expect(w.sessions()[ID]?.limited).toBeFalsy()
  await pastReset(w, R1)
  expect(w.continues().length).toBe(0)
})

test('12. usage-sentinel self-protection deny: not limited', async ($, on) => {
  denyBeneath(on, 'usage-sentinel：不允許修改 usage-sentinel 的狀態檔或 Claude Code 的憑證（自我保護）。')
  const w = world(on)
  await start($)
  await record($)
  await call($)
  expect(w.sessions()[ID]?.limited).toBeFalsy()
})
