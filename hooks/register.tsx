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

const WINDOW: Record<string, string> = { seven_day: 'Tuần này', five_hour: '5 giờ qua', spend_limit: 'Hạn mức chi' }

function resetLabel(iso: string | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return ` · reset ${pad(d.getDate())}/${pad(d.getMonth() + 1)} lúc ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function bar(pct: number, width: number): string {
  const full = Math.max(1, Math.round((Math.min(100, pct) / 100) * width))
  return '█'.repeat(full) + '·'.repeat(Math.max(0, width - full))
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
    const barWidth = Math.max(6, Math.min(20, (e.props.bodyColumns ?? 40) - 30))
    const choose = (days: 1 | 7) => () => {
      void update($, scan, x => ({ ...x, days }))
      void refresh($, days)
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Button key="week" label="7 ngày" variant={s.days === 7 ? 'primary' : 'secondary'} hotkey="w" onPress={choose(7)} />
          <Text> </Text>
          <Button key="day" label="24 giờ" variant={s.days === 1 ? 'primary' : 'secondary'} hotkey="d" onPress={choose(1)} />
          <Text> </Text>
          {report?.fixAll ? (
            <>
              <Button
                key="fix-all"
                label={`Sửa ${report.fixAll.count} trong ${report.fixAll.of} gợi ý (f)`}
                hotkey="f"
                variant="primary"
                onPress={() => void $.prompt.submit({ text: report.fixAll?.text ?? '' })}
              />
              <Text> </Text>
            </>
          ) : null}
          <Button key="refresh" label={s.isRunning ? 'Đang quét…' : 'Quét lại'} hotkey="r" onPress={() => void refresh($, s.days)} />
        </Box>
        {limits.map(l => (
          <Text color={l.percentUsed >= 80 ? 'yellow' : undefined}>
            {WINDOW[l.kind] ?? l.kind}: {bar(l.percentUsed, barWidth)} {l.percentUsed}% đã dùng{resetLabel(l.resetsAt)}
          </Text>
        ))}
        {s.error ? <Text color="red">Không quét được: {s.error}</Text> : null}
        {report ? (
          <Text dimColor>
            {report.requests} lượt gọi, khoảng {report.totalLabel} token quy đổi · quét {age(report.generatedAt)} ({Math.round(report.tookMs / 100) / 10} giây)
          </Text>
        ) : (
          <Text dimColor>{s.isRunning ? 'Đang đọc lịch sử phiên…' : 'Chưa có số liệu. Bấm Quét lại.'}</Text>
        )}
        {report && report.rows.length === 0 ? <Text>Không mục nào chiếm từ 3% trở lên. Không có gì cần sửa.</Text> : null}
        {(report?.rows ?? []).map(row => (
          <Box key={row.id} flexDirection="column" marginTop={1}>
            <Text bold={row.isMain} wrap="truncate-end">
              {row.sharePct}% {row.label}
            </Text>
            <Text color={row.isMain ? 'yellow' : undefined} dimColor={!row.isMain}>
              {bar(row.sharePct, barWidth)} {row.weightedLabel}
            </Text>
            <Text dimColor>{row.detail}</Text>
            <Button
              key={`fix:${row.id}`}
              label={s.sent.includes(row.id) ? (row.fix.type === 'compact' ? 'Đã thu gọn' : 'Đã gửi, gửi lại') : row.fix.type === 'compact' ? 'Thu gọn phiên này' : 'Sửa'}
              dimColor={s.sent.includes(row.id)}
              onPress={() => void applyFix($, row)}
            />
          </Box>
        ))}
        {(report?.breakdown ?? []).map(g => (
          <Box key={`group:${g.title}`} flexDirection="column" marginTop={1}>
            <Text bold>{g.title} · % usage</Text>
            {g.items.map(i => (
              <Text wrap="truncate-end">
                {String(i.sharePct).padStart(5)}%  {i.name}
              </Text>
            ))}
          </Box>
        ))}
        {report ? (
          <Box marginTop={1}>
            <Text dimColor>
              Ước tính: input ×1, ghi cache ×1,25 hoặc ×2, đọc cache ×0,1, output ×5. Một lượt có thể thuộc nhiều mục, nên tổng có thể quá 100%. Nút Sửa gửi một yêu cầu vào phiên; Claude cho xem từng thay đổi trước khi sửa.
            </Text>
          </Box>
        ) : null}
      </Box>
    )
  })
}
