import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionContextUsage, SessionRateLimit } from 'claude-code'

import type { Limit, Mode, Snapshot } from '../types'

const snap = atom(
  { plugin: 'usage-box', key: 'snap' } as const,
  { limits: [], contextPercent: null },
  { shape: 'snap-2' },
)
const warned = atom({ plugin: 'usage-box', key: 'warned' } as const, [])
const mode = atom({ plugin: 'usage-box', key: 'mode' } as const, 'row' as Mode)

const WINDOWS: Record<string, { label: string; short: string; ms: number }> = {
  five_hour: { label: '5 小時', short: '5h', ms: 5 * 3600_000 },
  seven_day: { label: '本週', short: '週', ms: 7 * 86400_000 },
}
const WARN = 70
const DANGER = 90

// Fixed colours: theme keys like `warning` are not mapped in the editor.
const GREEN = '#3fb950'
const AMBER = '#e3a53a'
const RED = '#f0524f'
const TRACK = 'rgba(140,140,140,0.22)'
const TICK = 'rgba(210,210,210,0.95)'
const BAR_CELLS = 10

const hex = (p: number) => (p >= DANGER ? RED : p >= WARN ? AMBER : GREEN)
const rgb = (h: string) => `rgb(${[1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)).join(',')})`
const theme = (p: number) => (p >= DANGER ? 'error' : p >= WARN ? 'warning' : 'success')
const pct = (p: number) => `${Math.round(p)}%`
const clamp = (n: number) => Math.max(0, Math.min(100, n))
const cells = (p: number) => Math.round((clamp(p) / 100) * BAR_CELLS)

function span(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60000))
  if (mins < 60) return `${mins}m`
  const h = Math.floor(mins / 60)
  if (h < 24) return `${h}h${String(mins % 60).padStart(2, '0')}`
  return `${Math.floor(h / 24)}d${h % 24}h`
}

/** A rounded bar as SVG: track, fill, and an optional elapsed-time tick. */
function svgBar(width: number, height: number, percent: number, tick: number | null): string {
  const r = height / 2
  const fill = Math.max(percent > 0 ? height : 0, (clamp(percent) / 100) * width)
  const tickX = tick === null ? null : Math.min(width - 1.5, Math.max(1.5, (tick / 100) * width))
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<rect width="${width}" height="${height}" rx="${r}" fill="${TRACK}"/>` +
    // rgb(), not #hex: a '#' cuts off the markup if a surface puts it in a data: URL unescaped.
    (fill > 0 ? `<rect width="${fill.toFixed(1)}" height="${height}" rx="${r}" fill="${rgb(hex(percent))}"/>` : '') +
    (tickX === null
      ? ''
      : `<rect x="${(tickX - 1).toFixed(1)}" y="0" width="2" height="${height}" rx="1" fill="${TICK}"/>`) +
    `</svg>`
  )
}

type View = Limit & {
  label: string
  short: string
  left: number | null
  elapsed: number | null
  runsOutIn: number | null
}

function viewOf(l: Limit, now: number): View | null {
  const w = WINDOWS[l.kind]
  if (!w) return null
  const reset = l.resetsAt ? Date.parse(l.resetsAt) : NaN
  const left = Number.isFinite(reset) ? Math.max(0, reset - now) : null
  const elapsed = left === null ? null : clamp(((w.ms - left) / w.ms) * 100)
  let runsOutIn: number | null = null
  if (left !== null && l.percentUsed > 0 && l.percentUsed < 100) {
    const spent = w.ms - left
    const eta = ((100 - l.percentUsed) * spent) / l.percentUsed
    if (spent > 0 && eta < left) runsOutIn = eta
  }
  return { ...l, label: w.label, short: w.short, left, elapsed, runsOutIn }
}

async function views($: EngineInterface): Promise<{ list: View[]; ctx: number | null }> {
  const s = await read($, snap)
  const now = await $.clock.now()
  // A missing five_hour means no reading, not 0%: the engine leaves out what it lacks.
  return {
    list: s.limits.map(l => viewOf(l, now)).filter((v): v is View => v !== null),
    ctx: s.contextPercent,
  }
}

async function save($: EngineInterface, limits: SessionRateLimit[], ctx: SessionContextUsage) {
  // No reading yet (fresh session, before the first response): keep the last good figures.
  if (limits.length === 0) limits = (await read($, snap)).limits
  const next: Snapshot = {
    limits: limits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt })),
    contextPercent: ctx.percent ?? null,
  }
  await update($, snap, () => next)
  await syncStatus($)

  // The pace forecast lives here only: one toast per window and threshold,
  // re-armed when the window resets.
  const { list } = await views($)
  const done = await read($, warned)
  const fresh: string[] = []
  for (const v of list) {
    const level = v.percentUsed >= DANGER ? DANGER : v.percentUsed >= 80 ? 80 : 0
    const tag = `${v.kind}:${level}:${v.resetsAt ?? ''}`
    if (level === 0 || done.includes(tag)) continue
    fresh.push(tag)
    const tail =
      v.runsOutIn !== null
        ? `照目前速度約 ${span(v.runsOutIn)} 後用完`
        : v.left !== null
          ? `${span(v.left)} 後重置`
          : ''
    $.ui.toast(`${v.label}用量 ${pct(v.percentUsed)}${tail ? `，${tail}` : ''}`)
  }
  if (fresh.length > 0) await update($, warned, old => [...old, ...fresh].slice(-20))
}

async function refresh($: EngineInterface) {
  const u = await $.session.usage()
  await save($, u.rateLimits, u.context)
}

/** The status line holds the figures only while the band is collapsed. */
async function syncStatus($: EngineInterface) {
  const { list } = await views($)
  const collapsed = (await read($, mode)) === 'pill'
  $.ui.status(
    !collapsed || list.length === 0
      ? undefined
      : list.map(v => `${v.short} ${pct(v.percentUsed)}`).join(' · '),
  )
}

async function setMode($: EngineInterface, m: Mode) {
  await update($, mode, () => m)
  await syncStatus($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const ran = await next(e)
    await $.command.register({
      name: 'usage-box',
      description: '叫回用量列（收合後用這個展開）',
      immediate: true,
    })
    await refresh($)
    return ran
  })

  on('command.run', { command: 'usage-box' }, async $ => {
    await refresh($)
    await setMode($, 'row')
    return { text: '已顯示用量列。' }
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits') || e.changed.includes('context')) {
      await save($, e.rateLimits, e.context)
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { list, ctx } = await views($)
    if (list.length === 0 && ctx === null) return next(e)

    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const Svg = 'Svg' in els ? els.Svg : undefined
    const isText = e.surface === 'terminal' || !Svg
    const current = await read($, mode)
    const color = (p: number) => (isText ? theme(p) : hex(p))

    // Collapsed: the band steps aside; the status line carries the figures.
    if (current === 'pill') return next(e)
    // Other mods share this slot (e.g. ponytail band): stack theirs below instead of replacing it.
    // next(e) rejects only when nothing answers beneath.
    const below = await next(e).catch(() => undefined)

    // One line of meters. Each meter is an unbreakable unit; when the band is
    // narrow, whole units move to the next line with no extra space between.
    const item = (key: string, label: string, p: number, tick: number | null, extra: string) => (
      <Box key={key} flexDirection="row" flexWrap="nowrap" flexShrink={0} alignItems="center" gap={1}>
        <Text dimColor>{label}</Text>
        {isText || !Svg ? (
          <Text>
            {Array.from({ length: BAR_CELLS }, (_, i) =>
              // The elapsed-time tick takes one cell: usage left of it is ahead of pace.
              tick !== null && i === Math.min(BAR_CELLS - 1, Math.floor((tick / 100) * BAR_CELLS)) ? (
                <Text key={i} bold>
                  ┃
                </Text>
              ) : i < cells(p) ? (
                <Text key={i} color={theme(p)}>
                  █
                </Text>
              ) : (
                <Text key={i} dimColor>
                  ░
                </Text>
              ),
            )}
          </Text>
        ) : (
          <Svg source={svgBar(48, 6, p, tick)} alt={`${label} ${pct(p)}`} width={48} height={6} />
        )}
        <Text color={color(p)} bold>
          {pct(p)}
        </Text>
        {extra !== '' && <Text dimColor>{extra}</Text>}
      </Box>
    )
    const row = (
      <Box
        key="usage-row"
        flexDirection="row"
        flexWrap="wrap"
        alignItems="center"
        columnGap={3}
        rowGap={0}
        paddingX={1}
      >
        {list.map(v =>
          item(v.kind, v.short, v.percentUsed, v.elapsed, v.left !== null ? `↻ ${span(v.left)}` : ''),
        )}
        {ctx !== null && item('ctx', 'ctx', ctx, null, '')}
        <Box key="actions" flexShrink={0} gap={1}>
          <Button key="refresh" label="刷新" plain dimColor onPress={() => refresh($)} />
          <Button key="collapse" label="收合" plain dimColor onPress={() => setMode($, 'pill')} />
        </Box>
      </Box>
    )
    return below ? <Box flexDirection="column">{row}{below}</Box> : row
  })
}
