import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { Report, Row, Scan } from '../types'

const PANE = 'usage-advisor'
const TITLE = 'Usage'
const NODES = [
  '$HOME/.local/share/fnm/aliases/default/bin/node',
  '/usr/local/bin/node',
  '/opt/homebrew/bin/node',
  '$HOME/.volta/bin/node',
]

const EMPTY: Scan = { days: 7, isRunning: false, error: null, week: null, day: null, sent: [] }
const scan = atom({ plugin: 'usage-advisor', key: 'scan' } as const, EMPTY, { shape: 'scan-1' })

// One scan at a time per loaded module; a reload starts with none running.
let running: Promise<void> | null = null

function scriptPath(root: string): string {
  const base = root.endsWith('/.claude-plugin') ? root.slice(0, -'/.claude-plugin'.length) : root
  return `${base}/scripts/scan.mjs`
}

/** Runs the scanner with the first node found, under a plain shell so no PATH is assumed. */
async function runScan($: EngineInterface, days: 1 | 7): Promise<Report> {
  const home = (await $.env.get('HOME')) ?? ''
  const cwd = await $.session.cwd()
  const tries = NODES.map(n => `[ -x "${n}" ] && exec "${n}" "$@";`).join(' ')
  const res = await $.process.run(
    ['/bin/sh', '-c', `${tries} exec node "$@"`, 'sh', scriptPath($.plugin.root), '--days', String(days), '--cwd', cwd],
    { env: { HOME: home }, timeoutMs: 600_000 },
  )
  let parsed: (Report & { error?: string }) | null = null
  try {
    parsed = JSON.parse(res.stdout) as Report & { error?: string }
  } catch {
    throw new Error(res.stderr.trim().split('\n').slice(-1)[0] || `scan exited ${res.exitCode}`)
  }
  if (parsed.error) throw new Error(parsed.error)
  return parsed
}

function refresh($: EngineInterface, days: 1 | 7): Promise<void> {
  if (running) return running
  running = (async () => {
    await update($, scan, s => ({ ...s, days, isRunning: true, error: null }))
    try {
      const report = await runScan($, days)
      await update($, scan, s => ({ ...s, isRunning: false, [days === 7 ? 'week' : 'day']: report }))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await update($, scan, s => ({ ...s, isRunning: false, error: message }))
    } finally {
      running = null
    }
  })()
  return running
}

async function applyFix($: EngineInterface, row: Row): Promise<void> {
  await update($, scan, s => ({ ...s, sent: [...s.sent.filter(id => id !== row.id), row.id] }))
  if (row.fix.type === 'compact') {
    $.ui.toast('Đang thu gọn phiên…')
    const result = await $.session.compact({ instructions: row.fix.text })
    $.ui.toast('messages' in result ? 'Đã thu gọn phiên.' : 'Phiên chưa thu gọn được.')
    return
  }
  await $.prompt.submit({ text: row.fix.text })
}

function age(iso: string): string {
  const min = Math.round((Date.now() - Date.parse(iso)) / 60_000)
  if (min < 1) return 'vừa xong'
  if (min < 60) return `${min} phút trước`
  return `${Math.round(min / 60)} giờ trước`
}

const WINDOW: Record<string, string> = { seven_day: 'Giới hạn tuần', five_hour: 'Giới hạn 5 giờ', spend_limit: 'Hạn mức chi' }
const WEEKDAY = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7']

/** Kinds a config change can fix; the rest need the person to change a habit. */
const CONFIG_KINDS = new Set(['skill', 'mcp', 'agent', 'plugin', 'effort', 'hook', 'instructions'])

const pad2 = (n: number) => String(n).padStart(2, '0')

function resetLabel(iso: string | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  return `Làm mới ${WEEKDAY[d.getDay()]} ${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}, ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** 26855 -> "26.855", the way Vietnamese writes thousands. */
function count(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')
}

/** A share as people say it: 75,5 -> "76%", under 10 keeps one decimal. */
function share(pct: number): string {
  return pct >= 10 ? `${Math.round(pct)}%` : `${String(pct).replace('.', ',')}%`
}

/** A thin meter: filled and empty cells of the same glyph weight, so it reads as one line. */
function meter(pct: number, width: number): { on: string; off: string } {
  const on = Math.max(0, Math.min(width, Math.round((pct / 100) * width)))
  return { on: '━'.repeat(on), off: '━'.repeat(width - on) }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'usage-advisor', description: 'Mở bảng Usage: usage 7 ngày qua đi đâu, và nút Sửa cho từng gợi ý' })
    // A reload leaves the stored flag set while no scan runs here.
    await update($, scan, s => (s.isRunning ? { ...s, isRunning: false } : s))
    void $.ui.open({ id: PANE, title: TITLE })
    void refresh($, 7)
    return next(e)
  })

  on('command.run', { command: 'usage-advisor' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE, focus: true })
    const s = await read($, scan)
    void refresh($, s.days)
    return { text: 'Đã mở bảng Usage.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const s = await read($, scan)
    const report = s.days === 7 ? s.week : s.day
    const limits = await $.session.usage().then(u => u.rateLimits, () => [])
    const width = Math.max(12, (e.props.bodyColumns ?? 40) - 2)
    const choose = (days: 1 | 7) => () => {
      void update($, scan, x => ({ ...x, days }))
      void refresh($, days)
    }
    const rows = report?.rows ?? []
    const configRows = rows.filter(r => CONFIG_KINDS.has(r.kind))
    const habitRows = rows.filter(r => !CONFIG_KINDS.has(r.kind))
    const period = s.days === 7 ? '7 ngày' : '24 giờ'

    const renderRow = (row: Row) => {
      const isSent = s.sent.includes(row.id)
      const label = row.fix.type === 'compact'
        ? (isSent ? 'Thu gọn lại' : 'Thu gọn phiên')
        : (isSent ? 'Gửi lại' : 'Sửa')
      return (
        <Box key={row.id} flexDirection="column" marginTop={1}>
          <Box flexDirection="row" justifyContent="space-between" alignItems="center" columnGap={1}>
            <Box flexDirection="row" flexShrink={1} columnGap={1}>
              <Text tabular weight="semibold" color={row.isMain ? undefined : 'subtle'}>{share(row.sharePct).padStart(4)}</Text>
              <Text wrap="truncate-end" weight={row.isMain ? 'medium' : 'regular'}>{row.label}</Text>
            </Box>
            <Button key={`fix:${row.id}`} label={label} dimColor={isSent} onPress={() => void applyFix($, row)} />
          </Box>
          <Box paddingLeft={5}>
            <Text size="footnote" color="subtle">
              {row.detail}{isSent ? ' · ' : ''}
              {isSent ? <Text size="footnote" color="success">{row.fix.type === 'compact' ? 'đã thu gọn' : 'đã gửi vào phiên'}</Text> : null}
            </Text>
          </Box>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" paddingX={1}>
        {/* Plan limits: the one thing to read first. */}
        {limits.length === 0 ? (
          <Text size="footnote" color="subtle">Chưa có số giới hạn của gói: Claude Code chỉ báo sau lượt gọi đầu tiên.</Text>
        ) : null}
        {limits.map(l => {
          const m = meter(l.percentUsed, width)
          const tone = l.percentUsed >= 90 ? 'error' : l.percentUsed >= 75 ? 'warning' : undefined
          return (
            <Box key={`limit:${l.kind}`} flexDirection="column" marginBottom={1}>
              <Box flexDirection="row" justifyContent="space-between" alignItems="flex-end">
                <Text size="footnote" color="subtle">{WINDOW[l.kind] ?? l.kind}</Text>
                <Text size="footnote" color="subtle">{resetLabel(l.resetsAt)}</Text>
              </Box>
              <Text size="title" weight="semibold" tabular color={tone}>{l.percentUsed}% đã dùng</Text>
              <Text wrap="truncate-end">
                <Text color={tone ?? 'text'}>{m.on}</Text>
                <Text color="inactive">{m.off}</Text>
              </Text>
            </Box>
          )
        })}

        {/* Period and scan state. */}
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" marginTop={1}>
          <Box flexDirection="row" columnGap={1}>
            <Button key="week" label="7 ngày" hotkey="w" dimColor={s.days !== 7} onPress={choose(7)} />
            <Button key="day" label="24 giờ" hotkey="d" dimColor={s.days !== 1} onPress={choose(1)} />
          </Box>
          <Button key="refresh" label={s.isRunning ? 'Đang quét…' : 'Quét lại'} hotkey="r" dimColor onPress={() => void refresh($, s.days)} />
        </Box>
        <Text size="footnote" color="subtle">
          {report
            ? `${count(report.requests)} lượt gọi trong ${period} · quét ${age(report.generatedAt)}`
            : s.isRunning ? 'Đang đọc lịch sử phiên trên máy này…' : 'Chưa có số liệu. Bấm Quét lại.'}
        </Text>
        {s.error ? <Text color="error">Không quét được: {s.error}</Text> : null}

        {/* One primary action. */}
        {report?.fixAll ? (
          <Box flexDirection="column" marginTop={1} padding={1} borderStyle="round" borderDimColor>
            <Text weight="semibold">{report.fixAll.count} thay đổi cấu hình có thể giảm usage</Text>
            <Text size="footnote" color="subtle">Claude cho xem từng thay đổi và chờ bạn duyệt trước khi sửa.</Text>
            <Box marginTop={1}>
              <Button
                key="fix-all"
                label={`Xem và sửa ${report.fixAll.count} mục (f)`}
                hotkey="f"
                variant="primary"
                onPress={() => void $.prompt.submit({ text: report.fixAll?.text ?? '' })}
              />
            </Box>
          </Box>
        ) : null}

        {report && rows.length === 0 ? (
          <Box marginTop={1}><Text>Không mục nào chiếm từ 3% usage trở lên. Không có gì cần đổi.</Text></Box>
        ) : null}

        {configRows.length ? (
          <Box flexDirection="column" marginTop={1}>
            <Text size="footnote" weight="semibold" color="subtle">ĐỔI CẤU HÌNH</Text>
            {configRows.map(renderRow)}
          </Box>
        ) : null}

        {habitRows.length ? (
          <Box flexDirection="column" marginTop={1}>
            <Text size="footnote" weight="semibold" color="subtle">THÓI QUEN LÀM VIỆC</Text>
            {habitRows.map(renderRow)}
          </Box>
        ) : null}

        {/* Detail on demand. */}
        {report?.breakdown?.length ? (
          <Box flexDirection="column" marginTop={1}>
            <Button
              key="detail"
              label={s.showDetail ? 'Ẩn chi tiết' : 'Chi tiết theo skill, plugin, MCP'}
              dimColor
              onPress={() => void update($, scan, x => ({ ...x, showDetail: !x.showDetail }))}
            />
            {s.showDetail
              ? report.breakdown.map(g => (
                  <Box key={`group:${g.title}`} flexDirection="column" marginTop={1}>
                    <Text size="footnote" weight="semibold" color="subtle">{g.title.toUpperCase()}</Text>
                    {g.items.map(i => (
                      <Box key={`${g.title}:${i.name}`} flexDirection="row" columnGap={1}>
                        <Text tabular color="subtle">{share(i.sharePct).padStart(5)}</Text>
                        <Text wrap="truncate-end">{i.name}</Text>
                      </Box>
                    ))}
                  </Box>
                ))
              : null}
          </Box>
        ) : null}

        {report ? (
          <Box marginTop={1}>
            <Text size="caption" color="subtle">
              % là phần usage có dính tới mục đó, nên các mục chồng lên nhau và cộng lại quá 100%. Số là ước tính từ lịch sử phiên trên máy này.
            </Text>
          </Box>
        ) : null}
      </Box>
    )
  })
}
