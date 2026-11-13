#!/usr/bin/env node
// Reads Claude Code session history under ~/.claude/projects and prints one JSON report:
// where the usage of the last N days went, and what to change. Run by the usage-advisor mod.
//
//   node scan.mjs --days 7|1 [--cwd <dir>]
//
// Usage is weighted the way the plans count it, as an estimate in "input-token equivalents":
// input x1, cache write x1.25 (5 min) or x2 (1 h), cache read x0.1, output x5.
// A per-file aggregate is cached by path, size and mtime, so later runs only read changed files.

import { createReadStream, promises as fs } from 'node:fs'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { join, dirname, basename } from 'node:path'

const HOME = homedir()
const ROOT = join(HOME, '.claude', 'projects')
const CACHE_DIR = join(HOME, '.cache', 'usage-advisor')
const CACHE_FILE = join(CACHE_DIR, 'cache-v2.json')
const LONG_CONTEXT = 200_000
const COLD_WRITE_MIN = 20_000
const SHOW_MIN_SHARE = 0.03
const DETAIL_MIN_SHARE = 0.01
const LONG_SESSION_MS = 8 * 3600_000
const MANY_PROMPTS = 20
const MAIN_SHARE = 0.1

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const days = Math.max(1, Math.min(7, Number(arg('days', '7')) || 7))
const sessionCwd = arg('cwd', '')

const dayKey = ms => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const now = Date.now()
const wantedDays = new Set()
for (let i = 0; i < days; i++) wantedDays.add(dayKey(now - i * 86_400_000))
const oldest = now - 7 * 86_400_000

function weigh(u) {
  const its = Array.isArray(u.iterations) && u.iterations.length ? u.iterations : [u]
  let w = 0, ctx = 0, cw = 0, cwW = 0, has1h = false
  for (const it of its) {
    const inp = it.input_tokens || 0
    const cr = it.cache_read_input_tokens || 0
    const c = it.cache_creation_input_tokens || 0
    const out = it.output_tokens || 0
    const c1h = it.cache_creation?.ephemeral_1h_input_tokens ?? 0
    const c5m = it.cache_creation ? (it.cache_creation.ephemeral_5m_input_tokens ?? 0) : c
    if (c1h > 0) has1h = true
    const write = c5m * 1.25 + c1h * 2 + Math.max(0, c - c1h - c5m) * 1.25
    w += inp + write + cr * 0.1 + out * 5
    ctx = Math.max(ctx, inp + cr + c)
    cw += c
    cwW += write
  }
  return { w, ctx, cw, cwW, has1h }
}

const emptyDay = () => ({
  w: 0, n: 0,
  skill: {}, mcp: {}, agent: {}, plugin: {},
  long: { w: 0, n: 0 }, cold: { w: 0, n: 0 }, effort: { w: 0, n: 0 },
  longSession: { w: 0, n: 0 }, manyTurns: { w: 0, n: 0 },
  hook: {}, cwd: {},
})
const add = (obj, k, v) => { obj[k] = (obj[k] || 0) + v }

async function readMeta(file) {
  try {
    const m = JSON.parse(await fs.readFile(file.replace(/\.jsonl$/, '.meta.json'), 'utf8'))
    return typeof m.agentType === 'string' ? m.agentType : 'general-purpose'
  } catch {
    return 'subagent'
  }
}

async function scanFile(file) {
  const isAgent = file.includes(`${'/'}subagents${'/'}`)
  const agentType = isAgent ? await readMeta(file) : null
  const byDay = {}
  const reqs = new Map() // requestId -> last record
  const order = []
  let hookTokens = 0
  let prompts = 0
  const hookByName = {}
  const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of lines) {
    const isAssistant = line.includes('"type":"assistant"') && line.includes('"usage"')
    const isHook = line.includes('"hook_additional_context"')
    const isPrompt = !isAgent && line.includes('"type":"user"') && !line.includes('"tool_result"')
    if (!isAssistant && !isHook && !isPrompt) continue
    let d
    try { d = JSON.parse(line) } catch { continue }
    if (isHook && d.type === 'attachment' && d.attachment?.type === 'hook_additional_context') {
      const a = d.attachment
      const text = Array.isArray(a.content) ? a.content.join('\n') : String(a.content ?? '')
      const t = text.length / 3.5
      hookTokens += t
      const name = String(a.hookName || a.hookEvent || 'hook')
      hookByName[name] = (hookByName[name] || 0) + t
      continue
    }
    if (isPrompt && d.type === 'user') {
      if (!d.isMeta && !d.isSidechain && !d.isCompactSummary) prompts += 1
      continue
    }
    if (d.type !== 'assistant' || !d.message?.usage) continue
    const id = d.requestId || d.message.id || `${order.length}`
    if (!reqs.has(id)) order.push(id)
    reqs.set(id, { d, hookTokens, hookShare: { ...hookByName }, prompts })
  }
  let first = Infinity, last = 0
  for (const { d } of reqs.values()) {
    const t = Date.parse(d.timestamp) || 0
    if (t) { first = Math.min(first, t); last = Math.max(last, t) }
  }
  const isLongSession = !isAgent && last - first >= LONG_SESSION_MS
  let prevT = 0
  for (const id of order) {
    const { d, hookTokens: ht, hookShare, prompts: before } = reqs.get(id)
    const t = Date.parse(d.timestamp) || 0
    const key = dayKey(t)
    const day = (byDay[key] ??= emptyDay())
    const u = weigh(d.message.usage)
    day.w += u.w
    day.n += 1
    if (d.attributionSkill) add(day.skill, d.attributionSkill, u.w)
    if (d.attributionMcpServer) add(day.mcp, d.attributionMcpServer, u.w)
    if (d.attributionPlugin) add(day.plugin, d.attributionPlugin, u.w)
    if (agentType) add(day.agent, agentType, u.w)
    if (isLongSession) { day.longSession.w += u.w; day.longSession.n += 1 }
    if (!isAgent && before > MANY_PROMPTS) { day.manyTurns.w += u.w; day.manyTurns.n += 1 }
    if (u.ctx > LONG_CONTEXT) { day.long.w += u.w; day.long.n += 1 }
    const gap = prevT ? (t - prevT) / 1000 : 0
    if (prevT && u.cw >= COLD_WRITE_MIN && gap >= (u.has1h ? 3600 : 300)) {
      day.cold.w += u.cwW
      day.cold.n += 1
    }
    const eff = d.effort || d.perTurnEffort
    if (eff === 'xhigh' || eff === 'max') { day.effort.w += u.w; day.effort.n += 1 }
    if (ht > 0) {
      for (const [name, tok] of Object.entries(hookShare)) add(day.hook, name, tok * 0.1)
    }
    if (!isAgent && d.cwd) add(day.cwd, d.cwd, 1)
    prevT = t || prevT
  }
  return byDay
}

async function walk(dir, out) {
  let entries
  try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) await walk(p, out)
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p)
  }
}

async function fileTokens(path) {
  try { return (await fs.readFile(path, 'utf8')).length / 3.5 } catch { return 0 }
}

async function mdTokensUnder(dir) {
  const files = []
  async function rec(d) {
    let es
    try { es = await fs.readdir(d, { withFileTypes: true }) } catch { return }
    for (const e of es) {
      const p = join(d, e.name)
      if (e.isDirectory()) await rec(p)
      else if (e.name.endsWith('.md')) files.push(p)
    }
  }
  await rec(dir)
  let t = 0
  for (const f of files) t += await fileTokens(f)
  return t
}

// What Claude Code loads into every request for a working directory: the user's CLAUDE.md and
// rules, the project's CLAUDE.md files from the directory up to the root, and its memory index.
async function instructionTokens(cwd) {
  const parts = []
  parts.push({ label: '~/.claude/CLAUDE.md', t: await fileTokens(join(HOME, '.claude', 'CLAUDE.md')) })
  parts.push({ label: '~/.claude/rules', t: await mdTokensUnder(join(HOME, '.claude', 'rules')) })
  let d = cwd
  for (let i = 0; i < 12 && d && d !== dirname(d); i++) {
    for (const f of ['CLAUDE.md', join('.claude', 'CLAUDE.md'), 'CLAUDE.local.md']) {
      const t = await fileTokens(join(d, f))
      if (t > 0) parts.push({ label: join(d, f).replace(HOME, '~'), t })
    }
    d = dirname(d)
  }
  const memDir = join(ROOT, cwd.replace(/[^A-Za-z0-9]/g, '-'), 'memory', 'MEMORY.md')
  const mt = await fileTokens(memDir)
  if (mt > 0) parts.push({ label: 'memory/MEMORY.md', t: mt })
  return parts.filter(p => p.t > 0)
}

const fmt = n => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : `${Math.round(n)}`
const pct = s => `${Math.round(s * 100)}%`
const SHOW_FIRST = 'Đừng sửa gì trước khi tôi đồng ý: cho tôi xem từng thay đổi (file, nội dung cũ, nội dung mới) rồi chờ tôi duyệt.'

async function main() {
  const t0 = Date.now()
  let cache = {}
  try { cache = JSON.parse(await fs.readFile(CACHE_FILE, 'utf8')) } catch {}
  const files = []
  await walk(ROOT, files)
  const fresh = {}
  let scanned = 0, reused = 0, failed = 0
  const total = emptyDay()
  for (const f of files) {
    let st
    try { st = await fs.stat(f) } catch { continue }
    if (st.mtimeMs < oldest) continue
    const hit = cache[f]
    let byDay
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) { byDay = hit.byDay; reused++ }
    else {
      try { byDay = await scanFile(f); scanned++ } catch { failed++; continue }
    }
    fresh[f] = { size: st.size, mtimeMs: st.mtimeMs, byDay }
    for (const [k, day] of Object.entries(byDay)) {
      if (!wantedDays.has(k)) continue
      total.w += day.w; total.n += day.n
      for (const b of ['skill', 'mcp', 'agent', 'plugin', 'hook', 'cwd']) for (const [n, v] of Object.entries(day[b])) add(total[b], n, v)
      for (const b of ['long', 'cold', 'effort', 'longSession', 'manyTurns']) { total[b].w += day[b].w; total[b].n += day[b].n }
    }
  }
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true })
    await fs.writeFile(CACHE_FILE, JSON.stringify(fresh))
  } catch {}

  const rows = []
  const T = total.w || 1
  const row = (r) => { if (r.weighted / T >= SHOW_MIN_SHARE) rows.push({ ...r, share: r.weighted / T }) }

  for (const [name, w] of Object.entries(total.skill)) {
    row({
      id: `skill:${name}`, kind: 'skill', label: `Skill ${name}`, weighted: w,
      detail: 'Lượt gọi model trong lúc skill này đang chạy.',
      fix: { type: 'prompt', text: `Skill "${name}" chiếm khoảng ${pct(w / T)} usage ${days} ngày qua (ước tính từ lịch sử phiên). Tìm SKILL.md của skill này, đo độ dài, rồi đề xuất cách làm nó tốn ít hơn: thu gọn mô tả và phần thân, tách phần tham khảo ra file chỉ đọc khi cần, hoặc thu hẹp điều kiện kích hoạt để nó không được gọi khi không cần. ${SHOW_FIRST}` },
    })
  }
  for (const [name, w] of Object.entries(total.mcp)) {
    row({
      id: `mcp:${name}`, kind: 'mcp', label: `Máy chủ MCP ${name}`, weighted: w,
      detail: 'Lượt gọi model có dùng công cụ của máy chủ này.',
      fix: { type: 'prompt', text: `Máy chủ MCP "${name}" gắn với khoảng ${pct(w / T)} usage ${days} ngày qua. Xem nó được bật ở đâu (settings, .mcp.json, plugin), những dự án nào thật sự dùng, và đề xuất: tắt ở dự án không dùng, hoặc đổi cách gọi để kết quả trả về ngắn hơn. ${SHOW_FIRST}` },
    })
  }
  for (const [name, w] of Object.entries(total.agent)) {
    row({
      id: `agent:${name}`, kind: 'agent', label: `Subagent ${name}`, weighted: w,
      detail: 'Toàn bộ lượt gọi model bên trong các subagent loại này.',
      fix: { type: 'prompt', text: `Subagent loại "${name}" chiếm khoảng ${pct(w / T)} usage ${days} ngày qua. Tìm định nghĩa agent này (file .md trong agents/ hoặc plugin), rồi đề xuất: chạy nó trên model rẻ hơn (trường model trong frontmatter), hạ effort, hoặc giao cho nó ít việc hơn. ${SHOW_FIRST}` },
    })
  }
  for (const [name, w] of Object.entries(total.plugin)) {
    row({
      id: `plugin:${name}`, kind: 'plugin', label: `Plugin ${name}`, weighted: w,
      detail: 'Lượt gọi model gắn với skill, agent hoặc công cụ của plugin này.',
      fix: { type: 'prompt', text: `Plugin "${name}" gắn với khoảng ${pct(w / T)} usage ${days} ngày qua. Liệt kê những skill, agent, hook và máy chủ MCP plugin này cài vào, phần nào tôi thật sự dùng, và đề xuất: tắt plugin ở dự án không cần, tắt riêng phần không dùng, hoặc cho agent của nó chạy model rẻ hơn. ${SHOW_FIRST}` },
    })
  }
  if (total.longSession.n) row({
    id: 'long-session', kind: 'session', label: 'Phiên chạy từ 8 giờ trở lên', weighted: total.longSession.w,
    detail: `${total.longSession.n} lượt gọi nằm trong phiên kéo dài từ 8 giờ trở lên (tính từ lượt đầu tới lượt cuối).`,
    fix: { type: 'prompt', text: `Khoảng ${pct(total.longSession.w / T)} usage ${days} ngày qua nằm trong các phiên kéo dài từ 8 giờ trở lên. Liệt kê các phiên Claude Code đang mở hoặc đang chạy nền trên máy này, việc mỗi phiên đang làm và lần cuối nó hoạt động, rồi đề xuất phiên nào nên dừng hoặc lưu trữ. Đừng dừng hay lưu trữ phiên nào trước khi tôi chọn.` },
  })
  if (total.manyTurns.n) row({
    id: 'many-turns', kind: 'session', label: `Phiên đã quá ${MANY_PROMPTS} lượt hỏi`, weighted: total.manyTurns.w,
    detail: 'Lượt gọi sau lượt hỏi thứ 20 của phiên vẫn mang theo ngữ cảnh của các việc trước.',
    fix: { type: 'prompt', text: `Khoảng ${pct(total.manyTurns.w / T)} usage ${days} ngày qua đến từ các phiên đã quá ${MANY_PROMPTS} lượt hỏi, nơi mỗi lượt vẫn mang theo ngữ cảnh của việc cũ. Viết cho tôi một bản bàn giao ngắn của phiên này (việc đang làm, quyết định đã chốt, file đang sửa, bước tiếp theo) để tôi chạy /clear rồi dán vào phiên mới khi đổi việc.` },
  })
  if (total.long.n) row({
    id: 'long', kind: 'long', label: 'Ngữ cảnh dài trên 200K token', weighted: total.long.w,
    detail: `${total.long.n} lượt gọi gửi đi hơn 200K token ngữ cảnh.`,
    fix: { type: 'compact', text: 'Thu gọn phiên này: giữ quyết định, file đang sửa và việc còn dở.' },
  })
  if (total.cold.n) row({
    id: 'cold', kind: 'cold', label: 'Cache hết hạn sau lúc nghỉ', weighted: total.cold.w,
    detail: `${total.cold.n} lần quay lại sau khi cache hết hạn, phải ghi lại toàn bộ ngữ cảnh.`,
    fix: { type: 'prompt', text: `Lịch sử ${days} ngày qua có ${total.cold.n} lần tôi quay lại một phiên sau khi cache hết hạn, tốn khoảng ${pct(total.cold.w / T)} usage chỉ để ghi lại ngữ cảnh. Kiểm tra cài đặt idleCompaction trong ~/.claude/settings.json và các settings của dự án, rồi đề xuất cách giảm (bật idleCompaction, hoặc /compact trước khi nghỉ lâu). ${SHOW_FIRST}` },
  })
  if (total.effort.n) row({
    id: 'effort', kind: 'effort', label: 'Effort xhigh hoặc max', weighted: total.effort.w,
    detail: `${total.effort.n} lượt chạy ở effort xhigh hoặc max.`,
    fix: { type: 'prompt', text: `Khoảng ${pct(total.effort.w / T)} usage ${days} ngày qua chạy ở effort xhigh hoặc max. Xem effort mặc định đang đặt ở đâu (settings effortLevel, frontmatter agent, biến môi trường) và đề xuất hạ mặc định xuống high hoặc medium, chỉ dùng ultrathink cho lượt thật sự khó. ${SHOW_FIRST}` },
  })
  for (const [name, w] of Object.entries(total.hook)) {
    row({
      id: `hook:${name}`, kind: 'hook', label: `Ngữ cảnh do hook ${name} chèn`, weighted: w,
      detail: 'Chữ hook chèn vào, được gửi lại ở mọi lượt sau đó (ước tính).',
      fix: { type: 'prompt', text: `Ngữ cảnh do hook "${name}" chèn vào chiếm khoảng ${pct(w / T)} usage ${days} ngày qua (ước tính). Tìm hook này trong settings và plugin, xem nó in ra gì, rồi đề xuất rút gọn: in ít hơn, chỉ in khi cần, hoặc in một lần thay vì mỗi lượt. ${SHOW_FIRST}` },
    })
  }

  // Instruction files: estimated as cache reads on every main-session request in each directory.
  const cwds = Object.entries(total.cwd).sort((a, b) => b[1] - a[1])
  const instr = {}
  let instrW = 0
  for (const [cwd, n] of cwds.slice(0, 20)) {
    for (const p of await instructionTokens(cwd)) {
      const w = p.t * 0.1 * n
      instrW += w
      add(instr, p.label, w)
    }
  }
  if (instrW > 0) {
    const top = Object.entries(instr).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([l]) => l)
    row({
      id: 'instructions', kind: 'instructions', label: 'CLAUDE.md, rules và memory', weighted: instrW,
      detail: `Nạp vào mọi lượt. Lớn nhất: ${top.join(', ')}.`,
      fix: { type: 'prompt', text: `Các file hướng dẫn nạp vào mọi lượt (${top.join(', ')}) chiếm khoảng ${pct(instrW / T)} usage ${days} ngày qua (ước tính theo độ dài file). Đo từng file, rồi đề xuất rút gọn: bỏ phần trùng, chuyển phần ít dùng sang file chỉ đọc khi cần và để lại một dòng trỏ tới. ${SHOW_FIRST}` },
    })
  }

  rows.sort((a, b) => b.weighted - a.weighted)
  const detail = b => Object.entries(total[b])
    .filter(([, w]) => w / T >= DETAIL_MIN_SHARE)
    .sort((x, y) => y[1] - x[1])
    .map(([name, w]) => ({ name, sharePct: Math.round((w / T) * 1000) / 10 }))
  const breakdown = [
    { title: 'Skill', items: detail('skill') },
    { title: 'Subagent', items: detail('agent') },
    { title: 'Plugin', items: detail('plugin') },
    { title: 'Máy chủ MCP', items: detail('mcp') },
  ].filter(g => g.items.length)
  const out = {
    generatedAt: new Date().toISOString(),
    days,
    totalWeighted: total.w,
    totalLabel: fmt(total.w),
    requests: total.n,
    files: { scanned, reused, failed },
    tookMs: Date.now() - t0,
    sessionCwd,
    breakdown,
    rows: rows.slice(0, 20).map(r => ({
      id: r.id, kind: r.kind, label: r.label, detail: r.detail, fix: r.fix,
      sharePct: Math.round(r.share * 1000) / 10, isMain: r.share >= MAIN_SHARE, weightedLabel: fmt(r.weighted),
    })),
  }
  process.stdout.write(JSON.stringify(out))
}

main().catch(err => {
  process.stdout.write(JSON.stringify({ error: String(err?.message || err) }))
  process.exitCode = 1
})
