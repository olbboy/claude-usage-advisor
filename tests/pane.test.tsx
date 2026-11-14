import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'usage-advisor',
  component: 'Pane',
  requestId: 'usage-advisor',
  props: {
    title: 'Usage',
    isFocused: false,
    bodyColumns: 48,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const REPORT = {
  generatedAt: new Date().toISOString(),
  days: 7,
  totalLabel: '1.1B',
  requests: 26341,
  tookMs: 11277,
  rows: [
    {
      id: 'effort', kind: 'effort', label: 'Effort xhigh hoặc max', detail: '18300 lượt chạy ở effort xhigh hoặc max.',
      fix: { type: 'prompt', text: 'Hạ effort mặc định. Cho tôi xem từng thay đổi.' },
      sharePct: 67.9, isMain: true, weightedLabel: '732.2M',
      since: { fixedAt: '2026-11-13T12:19:09.000Z', requests: 700, sharePct: 58.5 },
    },
    {
      id: 'long', kind: 'long', label: 'Ngữ cảnh dài trên 200K token', detail: '18051 lượt.',
      fix: { type: 'compact', text: 'Giữ quyết định.' },
      sharePct: 75.3, isMain: true, weightedLabel: '812.3M',
    },
  ],
  fixAll: { count: 1, of: 2, text: 'Sửa những gì bảng Usage chỉ ra.\n1. Hạ effort.' },
  breakdown: [{ title: 'Plugin', items: [{ name: 'ak-engineer', sharePct: 12.3 }, { name: 'mattpocock-skills', sharePct: 1.6 }] }],
}

test('the pane lists what used the usage and a Fix sends its prompt', async ($, on) => {
  const submitted: string[] = []
  const written: string[] = []
  on('fs.read', () => ({ value: '{"long":1}' }))
  on('fs.write', (_, e) => {
    written.push(String((e as { text?: unknown }).text ?? JSON.stringify(e)))
    return { value: undefined }
  })
  on('command.register', () => ({ value: { command: 'usage-advisor' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('env.get', () => ({ value: '/Users/test' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200000 }, rateLimits: [{ kind: 'seven_day', percentUsed: 84, resetsAt: '2026-11-17T07:00:00Z' }] },
  }))
  on('process.run', () => ({
    value: { exitCode: 0, stdout: JSON.stringify(REPORT), stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('prompt.submit', (_, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /^26\.341 lượt gọi trong 7 ngày/ }))).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /^Effort xhigh hoặc max$/ }))).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /^\s*68%$/ }))).toBeDefined()
    expect((await ui.find({ key: 'fix:long' }))?.text).toBe('Thu gọn phiên')
    expect((await ui.find({ type: 'Text', text: /^84% đã dùng$/ }))).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /^Từ lần sửa \(13\/11 19:00\): 59%, cả khung là 68%$/ }))).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /^Làm mới T3 17\/11, 14:00$/ }))).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /mattpocock-skills/ })).toBeUndefined()
    await ui.press({ key: 'detail' })
    expect((await ui.find({ type: 'Text', text: /^mattpocock-skills$/ }))).toBeDefined()
    await ui.press({ key: 'detail' })
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'fix:effort' })
  expect(submitted).toEqual(['Hạ effort mặc định. Cho tôi xem từng thay đổi.'])
  expect(written.join('\n')).toMatch(/"long":1.*"effort":\d+/)
  expect((await ui.find({ key: 'fix-all' }))?.text).toBe('Xem và sửa 1 mục (f)')
  await ui.press({ key: 'fix-all' })
  expect(submitted[1]).toBe('Sửa những gì bảng Usage chỉ ra.\n1. Hạ effort.')
  expect((await ui.find({ key: 'fix:effort' }))?.text).toBe('Gửi lại')
  await ui.unmount()
})

test('a scan that fails says why', async ($, on) => {
  on('command.register', () => ({ value: { command: 'usage-advisor' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('env.get', () => ({ value: '/Users/test' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('process.run', () => ({
    value: { exitCode: 127, stdout: '', stderr: 'sh: node: not found', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Không quét được: sh: node: not found/ }))).toBeDefined()
  await ui.unmount()
})
