import type { EngineInterface } from 'claude-code'

// Mermaid diagrams in replies, in one of two modes (`/ui-theme mermaid image|unicode|off`):
//
//   unicode  box-drawing art (┌─┐ │ ►), coloured in the theme; works in any terminal
//   image    a PNG through the kitty graphics protocol (Ghostty, kitty); the alt text elsewhere
//
// A closed ```mermaid fence is rendered off the draw path: the hook draws the code block with a
// "rendering" note, a helper process (mermaid/render.mjs, beautiful-mermaid) renders it, and a
// redraw swaps in the result. Results are cached in memory and on disk by a hash of the diagram
// and the mode (and, for images, the theme colours, which are baked into the picture; Unicode art
// is coloured at draw time, so a theme switch needs no new render).
//
// The helper's npm packages are installed once into the plugin's data folder.

const PACKAGES = ['beautiful-mermaid@1.1.3', '@resvg/resvg-js@2.6.2']

// Terminal cells are about twice as tall as they are wide, and a diagram's CSS pixels map to
// roughly 8 per column at its natural size.
const CELL_RATIO = 0.5
const PX_PER_COLUMN = 8

export type MermaidMode = 'unicode' | 'image' | 'off'
export type MermaidColors = { bg: string; fg: string; accent: string; line: string; muted: string; border: string }

// unicode: the art at several spacings, roomiest first
type Entry =
  | { kind: 'image'; base64: string; width: number; height: number }
  | { kind: 'unicode'; variants: string[] }
  | { kind: 'error'; error: string }
type Request = { id: string; src: string }

const cache = new Map<string, Entry>()
const pending = new Set<string>()
let paths: { lib: string; out: string } | undefined
let installing: Promise<void> | undefined

export const mermaidConfig: { mode: MermaidMode } = { mode: 'unicode' }

export function parseMode(text: string): MermaidMode | undefined {
  const t = text.trim()
  if (t === 'on') return 'unicode' // older setting files
  return t === 'unicode' || t === 'image' || t === 'off' ? t : undefined
}

// Forget failed renders so the next draw tries them again (after a fix, or a mode change)
export function clearMermaidErrors() {
  for (const [id, e] of cache) if (e.kind === 'error') cache.delete(id)
}

// 64-bit id from two 32-bit hashes (djb2 and FNV-1a)
export function mermaidId(src: string, key: string) {
  const text = src + '\0' + key
  let a = 5381, b = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    a = ((a << 5) + a + c) >>> 0
    b = Math.imul(b ^ c, 0x01000193) >>> 0
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')
}

function cacheKey(mode: MermaidMode, colors: MermaidColors) {
  return mode === 'image' ? `image ${JSON.stringify(colors)}` : 'unicode'
}

// The picture's box in cells: its natural width, capped by the room in the reply box
export function imageSize(width: number, height: number, available: number) {
  const columns = Math.max(10, Math.min(255, available, Math.ceil(width / PX_PER_COLUMN)))
  const rows = Math.max(1, Math.min(255, Math.round(columns * (height / Math.max(1, width)) * CELL_RATIO)))
  return { columns, rows }
}

const widthOf = (text: string) => Math.max(0, ...text.split('\n').map(l => [...l].length))

// The roomiest variant that fits; the tightest when none does (its lines are cut at the edge)
export function pickVariant(variants: string[], available: number) {
  return variants.find(v => widthOf(v) <= available) ?? variants[variants.length - 1] ?? ''
}

type Table = { Box: any; Text: any; Code: any; Image?: any }

// Box-drawing in the line colour, arrowheads in the accent, labels in the text colour
const ART_RUNS = /([─-╿]+)|([▲-◇←-⇿]+)|([^─-╿▲-◇←-⇿]+)/g
function artLine(line: string, colors: MermaidColors, t: Table, key: string) {
  const { Text } = t
  const parts: any[] = []
  let k = 0
  for (const m of line.matchAll(ART_RUNS)) {
    const color = m[1] ? colors.line : m[2] ? colors.accent : colors.fg
    parts.push(<Text key={`${key}-${k++}`} color={color}>{m[0]}</Text>)
  }
  return <Text key={key} wrap="truncate-end">{parts.length ? parts : ' '}</Text>
}

// Draw one mermaid fence. Missing results are added to `requests` for the caller to render.
export function drawMermaid(
  t: Table, src: string, closed: boolean, colors: MermaidColors, available: number, requests: Request[],
  mode: MermaidMode = mermaidConfig.mode,
) {
  const { Box, Text, Code, Image } = t
  const code = <Code source={src} language="mermaid" />
  // off, still streaming, or pictures on a surface without them: the code block as before
  if (mode === 'off' || !closed || !src.trim() || (mode === 'image' && !Image)) return code
  const id = mermaidId(src, cacheKey(mode, colors))
  const entry = cache.get(id)
  if (entry?.kind === 'image') {
    const { columns, rows } = imageSize(entry.width, entry.height, available)
    return <Image key={`mermaid-${id}`} source={{ png: entry.base64 }} columns={columns} rows={rows} alt="[mermaid diagram: this terminal shows no images]" />
  }
  if (entry?.kind === 'unicode') {
    const art = pickVariant(entry.variants, available).split('\n')
    return <Box flexDirection="column">{art.map((l, i) => artLine(l, colors, t, `mm-${id}-${i}`))}</Box>
  }
  if (entry?.kind === 'error') {
    return (
      <Box flexDirection="column">
        {code}
        <Text color="#d9534f" dimColor>mermaid: {entry.error}</Text>
      </Box>
    )
  }
  requests.push({ id, src })
  return (
    <Box flexDirection="column">
      {code}
      <Text dimColor>rendering diagram…</Text>
    </Box>
  )
}

async function setup($: EngineInterface) {
  if (!paths) {
    const env = await $.process.hookEnv()
    const data = env.CLAUDE_PLUGIN_DATA
    if (!data) throw new Error('no plugin data folder')
    paths = { lib: `${data}/mermaid-lib`, out: `${data}/mermaid-cache` }
  }
  const { lib } = paths
  if (!(await $.fs.exists(`${lib}/node_modules/beautiful-mermaid/package.json`))
    || !(await $.fs.exists(`${lib}/node_modules/@resvg/resvg-js/package.json`))) {
    installing ??= (async () => {
      $.ui.toast('ui-themes: installing the Mermaid renderer (one time)…')
      await $.fs.write(`${lib}/package.json`, '{ "private": true }\n')
      const r = await $.process.run(
        ['npm', 'install', '--prefix', lib, '--no-audit', '--no-fund', '--loglevel=error', ...PACKAGES],
        { timeoutMs: 300_000 },
      )
      if (r.exitCode !== 0) throw new Error(`npm install failed: ${(r.stderr || r.stdout).trim().split('\n').pop()}`)
      $.ui.toast('ui-themes: Mermaid renderer installed')
    })().finally(() => { installing = undefined })
    await installing
  }
  return paths
}

// An <Image> with a bad picture makes the engine refuse the whole reply's tree, so only a
// whole PNG within the 2 MiB limit is drawn.
const PNG_START = 'iVBORw0KGgoAAAANSUhEUg' // signature, then the IHDR chunk
const MAX_BASE64 = Math.ceil((2 * 1024 * 1024) / 3) * 4

function picture(base64: string, meta: { width: number; height: number }): Entry {
  if (!base64.startsWith(PNG_START)) return { kind: 'error', error: 'the renderer wrote no PNG' }
  if (base64.length > MAX_BASE64) return { kind: 'error', error: 'diagram too large to show as an image (over 2 MiB)' }
  if (!(meta.width > 0 && meta.height > 0)) return { kind: 'error', error: 'diagram has no size' }
  return { kind: 'image', base64, ...meta }
}

// <out>/<id>.json holds { width, height } (an image, beside <id>.png) or { variants } (Unicode art)
async function fromDisk($: EngineInterface, out: string, id: string): Promise<Entry | undefined> {
  try {
    if (!(await $.fs.exists(`${out}/${id}.json`))) return undefined
    const meta = JSON.parse(await $.fs.read(`${out}/${id}.json`)) as { width?: number; height?: number; variants?: string[] }
    if (Array.isArray(meta.variants)) return { kind: 'unicode', variants: meta.variants }
    const { base64 } = await $.fs.read(`${out}/${id}.png`, { as: 'bytes' })
    const entry = picture(base64, { width: meta.width ?? 0, height: meta.height ?? 0 })
    return entry.kind === 'error' ? undefined : entry
  } catch { return undefined }
}

type HelperResult = { id: string; ok: boolean; width?: number; height?: number; variants?: string[]; error?: string }

// Requests from every reply drawn within BATCH_MS are rendered together and followed by ONE
// redraw. Without this, switching modes with many diagrams on screen started a render and a
// redraw per reply, and the burst of redraws and newly mounted images crashed Claude Code's
// interface (React error #185, "maximum update depth exceeded").
const BATCH_MS = 50
const queued = new Map<string, { colors: MermaidColors; mode: MermaidMode; requests: Map<string, Request> }>()
let flushing = false

export function scheduleMermaid($: EngineInterface, requests: Request[], colors: MermaidColors, mode: MermaidMode) {
  if (mode === 'off') return
  const key = cacheKey(mode, colors)
  const batch = queued.get(key) ?? { colors, mode, requests: new Map<string, Request>() }
  queued.set(key, batch)
  for (const r of requests) if (!pending.has(r.id) && !cache.has(r.id)) batch.requests.set(r.id, r)
  if (flushing) return
  flushing = true
  void (async () => {
    try {
      await $.clock.sleep(BATCH_MS)
    } finally {
      flushing = false
      const batches = [...queued.values()]
      queued.clear()
      let rendered = false
      for (const b of batches) {
        if (b.requests.size && await renderMermaid($, [...b.requests.values()], b.colors, b.mode, false)) rendered = true
      }
      if (rendered) $.ui.invalidate('ui.render')
    }
  })()
}

// Render the requested diagrams (one helper run for all); true when anything new was cached.
// `redraw` false leaves the redraw to the caller (scheduleMermaid, once per batch).
export async function renderMermaid(
  $: EngineInterface, requests: Request[], colors: MermaidColors, mode: MermaidMode = mermaidConfig.mode, redraw = true,
): Promise<boolean> {
  if (mode === 'off') return false
  const todo = requests.filter(r => !pending.has(r.id) && !cache.has(r.id))
  if (!todo.length) return false
  for (const r of todo) pending.add(r.id)
  try {
    const { lib, out } = await setup($)
    const missing: Request[] = []
    for (const r of todo) {
      const hit = await fromDisk($, out, r.id)
      if (hit) cache.set(r.id, hit)
      else missing.push(r)
    }
    if (missing.length) {
      const res = await $.process.run(
        ['node', `${$.plugin.root}/mermaid/render.mjs`, lib, out],
        { stdin: JSON.stringify({ mode, colors, items: missing }), timeoutMs: 60_000 },
      )
      if (res.exitCode !== 0) throw new Error((res.stderr || 'renderer failed').trim().split('\n').pop())
      for (const r of JSON.parse(res.stdout) as HelperResult[]) {
        if (!r.ok) { cache.set(r.id, { kind: 'error', error: r.error ?? 'could not render' }); continue }
        if (Array.isArray(r.variants)) {
          await $.fs.write(`${out}/${r.id}.json`, JSON.stringify({ variants: r.variants }))
          cache.set(r.id, { kind: 'unicode', variants: r.variants })
          continue
        }
        const meta = { width: r.width ?? 0, height: r.height ?? 0 }
        await $.fs.write(`${out}/${r.id}.json`, JSON.stringify(meta))
        const { base64 } = await $.fs.read(`${out}/${r.id}.png`, { as: 'bytes' })
        cache.set(r.id, picture(base64, meta))
      }
      // an item the helper did not answer is not tried again on every redraw
      for (const r of missing) if (!cache.has(r.id)) cache.set(r.id, { kind: 'error', error: 'the renderer gave no result' })
    }
  } catch (err) {
    const error = String((err as Error)?.message ?? err)
    for (const r of todo) if (!cache.has(r.id)) cache.set(r.id, { kind: 'error', error })
  } finally {
    for (const r of todo) pending.delete(r.id)
    if (redraw) $.ui.invalidate('ui.render')
  }
  return true
}
