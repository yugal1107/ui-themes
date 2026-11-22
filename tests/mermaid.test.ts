import { test, expect, mock } from 'claude-code/testing'

import { imageSize, mermaidId, parseMode, pickVariant } from '../hooks/mermaid'

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
const WIDE = '┌──────────────────────────────┐\n│ a wide box, 32 columns       │\n└──────────────────────────────┘'
const NARROW = '┌────┐\n│ ok │\n└──┬─┘\n   ▼'

// Fake files and processes. The renderer "draws" every diagram 640×320 in image mode, and as
// two Unicode variants (32 and 6 columns wide) in unicode mode.
function fakeHost(on: any, files: Record<string, string>, runs: string[][], redraws = { count: 0 }) {
  on('env.get', () => ({ value: '/home/t' }))
  on('fs.exists', ($: any, e: any) => ({ value: e.path in files || /node_modules\/.+package\.json$/.test(e.path) }))
  on('fs.read', ($: any, e: any) => {
    if (String(e.path).endsWith('.png')) return { value: { base64: PNG_1PX } }
    const v = files[e.path]
    return v === undefined ? { deny: 'ENOENT' } : { value: v }
  })
  on('fs.write', ($: any, e: any) => { files[e.path] = e.text; return { value: undefined } })
  on('fs.list', () => ({ value: [] }))
  on('command.register', () => ({ value: undefined }))
  on('ui.invalidate', () => { redraws.count++; return { value: undefined } })
  on('session.start', () => ({ cwd: '/tmp' }) as any)
  on('process.hookEnv', () => ({ value: { CLAUDE_PLUGIN_DATA: '/data' } }))
  on('process.run', ($: any, e: any) => {
    runs.push([...e.argv])
    const input = JSON.parse(e.init?.stdin ?? '{"items":[]}') as { mode: string; items: Array<{ id: string }> }
    const out = input.items.map(i => input.mode === 'unicode'
      ? { id: i.id, ok: true, variants: [WIDE, NARROW] }
      : { id: i.id, ok: true, width: 640, height: 320 })
    return { value: { exitCode: 0, stderr: '', stdout: JSON.stringify(out) } }
  })
}

async function drawUntil($: any, clock: any, text: string, columns: number, want: string) {
  const draw = async () => JSON.stringify(await $.ui.render({
    surface: 'terminal', component: 'AssistantMessage', requestId: `mm-${columns}`, viewport: { columns, rows: 40 },
    props: { text, isFirstOfReply: true },
  } as any))
  const first = await draw()
  let json = first
  for (let i = 0; i < 20 && !json.includes(want); i++) {
    await clock.advance(100) // past the batch window
    json = await draw()
  }
  return { first, json }
}

test('a mermaid fence still streaming stays a code block', async ($, on) => {
  on('ui.render', { component: 'AssistantMessage' }, () => null as any)
  const tree = await $.ui.render({
    surface: 'terminal', component: 'AssistantMessage', requestId: 'mm1',
    props: { text: 'Here:\n\n```mermaid\nflowchart LR\n  A --> B', isFirstOfReply: true },
  } as any)
  const json = JSON.stringify(tree)
  expect(json).toContain('flowchart LR')
  expect(json).not.toContain('rendering diagram')
})

test('unicode is the default: a closed fence becomes box-drawing art that fits the room', async ($, on) => {
  const files: Record<string, string> = {}
  const runs: string[][] = []
  fakeHost(on, files, runs)
  const clock = mock.clock(on)
  on('ui.render', { component: 'AssistantMessage' }, () => null as any)
  await $.session.start({ source: 'startup', cwd: '/tmp' } as any)
  const text = '```mermaid\nflowchart LR\n  U --> V\n```'
  const wide = await drawUntil($, clock, text, 120, '┌──')
  expect(wide.first).toContain('rendering diagram')
  expect(wide.json).toContain(' a wide box, 32 columns')
  expect(wide.json).not.toContain('"Image"')
  // 30 columns leave too little room for the wide variant: the narrow one is drawn
  const narrow = await drawUntil($, clock, text, 30, '┌──')
  // the art is split into coloured runs: border, label, border
  expect(narrow.json).toContain('" ok "')
  expect(narrow.json).not.toContain('a wide box')
  expect(runs.filter(r => r[0] === 'node').length).toBe(1)
})

test('image mode draws a closed fence as a picture, rendered once', async ($, on) => {
  const files: Record<string, string> = { '/home/t/.claude/ui-themes/mermaid': 'image\n' }
  const runs: string[][] = []
  fakeHost(on, files, runs)
  const clock = mock.clock(on)
  on('ui.render', { component: 'AssistantMessage' }, () => null as any)
  await $.session.start({ source: 'startup', cwd: '/tmp' } as any)
  const { first, json } = await drawUntil($, clock, '```mermaid\nflowchart LR\n  I --> J\n```', 120, '"Image"')
  expect(first).toContain('rendering diagram')
  expect(json).toContain('"Image"')
  expect(json).toContain('"columns":80')
  expect(json).toContain('"rows":20')
  expect(runs.filter(r => r[0] === 'node').length).toBe(1)
})

test('diagrams from many replies drawn together are rendered in one run and one redraw', async ($, on) => {
  const files: Record<string, string> = { '/home/t/.claude/ui-themes/mermaid': 'image\n' }
  const runs: string[][] = []
  const redraws = { count: 0 }
  fakeHost(on, files, runs, redraws)
  const clock = mock.clock(on)
  on('ui.render', { component: 'AssistantMessage' }, () => null as any)
  await $.session.start({ source: 'startup', cwd: '/tmp' } as any)
  redraws.count = 0
  const draw = (i: number) => $.ui.render({
    surface: 'terminal', component: 'AssistantMessage', requestId: `burst-${i}`, viewport: { columns: 120, rows: 40 },
    props: { text: `\`\`\`mermaid\nflowchart LR\n  B${i} --> C${i}\n\`\`\``, isFirstOfReply: true },
  } as any)
  for (let i = 0; i < 7; i++) await draw(i)
  await clock.advance(100)
  for (let i = 0; i < 20 && redraws.count === 0; i++) await clock.advance(0)
  expect(runs.filter(r => r[0] === 'node').length).toBe(1)
  expect(redraws.count).toBe(1)
  expect(JSON.stringify(await draw(3))).toContain('"Image"')
})

test('with diagrams off, a closed mermaid fence is a plain code block', async ($, on) => {
  const files: Record<string, string> = { '/home/t/.claude/ui-themes/mermaid': 'off\n' }
  const runs: string[][] = []
  fakeHost(on, files, runs)
  const clock = mock.clock(on)
  on('ui.render', { component: 'AssistantMessage' }, () => null as any)
  await $.session.start({ source: 'startup', cwd: '/tmp' } as any)
  const json = JSON.stringify(await $.ui.render({
    surface: 'terminal', component: 'AssistantMessage', requestId: 'mm3',
    props: { text: '```mermaid\nflowchart LR\n  O --> P\n```', isFirstOfReply: true },
  } as any))
  expect(json).toContain('flowchart LR')
  expect(json).not.toContain('rendering diagram')
  expect(runs.length).toBe(0)
})

test('the id changes with the diagram and with the key', async () => {
  const a = mermaidId('flowchart LR\n A --> B', 'unicode')
  expect(a).toMatch(/^[0-9a-f]{16}$/)
  expect(mermaidId('flowchart LR\n A --> B', 'unicode')).toBe(a)
  expect(mermaidId('flowchart LR\n A --> C', 'unicode')).not.toBe(a)
  expect(mermaidId('flowchart LR\n A --> B', 'image {}')).not.toBe(a)
})

test('a picture keeps its shape and fits the room', async () => {
  // 640×320 px at 8 px a column → 80 columns, half as many rows again for the cell shape
  expect(imageSize(640, 320, 200)).toEqual({ columns: 80, rows: 20 })
  // narrower room: capped, rows follow
  expect(imageSize(640, 320, 40)).toEqual({ columns: 40, rows: 10 })
})

test('the roomiest art that fits is picked, the tightest when none does', async () => {
  expect(pickVariant([WIDE, NARROW], 100)).toBe(WIDE)
  expect(pickVariant([WIDE, NARROW], 10)).toBe(NARROW)
  expect(pickVariant([WIDE, NARROW], 3)).toBe(NARROW)
})

test('mode settings parse, the old `on` reading as unicode', async () => {
  expect(parseMode('image\n')).toBe('image')
  expect(parseMode('unicode')).toBe('unicode')
  expect(parseMode('off')).toBe('off')
  expect(parseMode('on')).toBe('unicode')
  expect(parseMode('pictures')).toBeUndefined()
})
