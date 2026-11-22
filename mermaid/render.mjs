// Mermaid → PNG helper for ui-themes. Run by the hooks module with $.process.run:
//
//   node render.mjs <libDir> <outDir>     stdin:  { mode, colors, items: [{ id, src }] }
//
//   mode "image"    stdout: [{ id, ok, width, height, error? }], each picture in <outDir>/<id>.png;
//                   width/height are CSS pixels, the PNG is drawn at SCALE times that
//   mode "unicode"  stdout: [{ id, ok, variants, error? }]: box-drawing art at each spacing in
//                   ART_SPACINGS, roomiest first, for the caller to pick the widest that fits
//
// <libDir> holds node_modules with beautiful-mermaid and @resvg/resvg-js (installed once into
// the plugin's data folder).
//
// beautiful-mermaid's SVG uses CSS custom properties and color-mix(), which resvg does not
// support, so every var(...) is resolved to a plain colour here before rasterizing.

import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const SCALE = 2
const [libDir, outDir] = process.argv.slice(2)
if (!libDir || !outDir) {
  process.stderr.write('usage: node render.mjs <libDir> <outDir>\n')
  process.exit(2)
}

const require = createRequire(join(libDir, 'package.json'))
const { renderMermaidSVG, renderMermaidASCII } = await import(pathToFileURL(join(libDir, 'node_modules/beautiful-mermaid/dist/index.js')).href)

// Unicode art spacings, roomiest first (the same idea as pi-mermaid's padding presets)
const ART_SPACINGS = [
  { paddingX: 5, paddingY: 5, boxBorderPadding: 1 },
  { paddingX: 3, paddingY: 2, boxBorderPadding: 1 },
  { paddingX: 2, paddingY: 1, boxBorderPadding: 0 },
]

const tidy = art => art.split('\n').map(l => l.replace(/\s+$/, '')).join('\n').replace(/^\n+|\n+$/g, '')

// --- colours ---

function parseHex(s) {
  const h = s.trim().replace(/^#/, '')
  const full = h.length === 3 ? [...h].map(c => c + c).join('') : h.slice(0, 6)
  const n = parseInt(full, 16)
  return Number.isNaN(n) ? null : [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

const toHex = rgb => '#' + rgb.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')

// color-mix(in srgb, A p%, B): p% of A, the rest B
function colorMix(args, vars) {
  const parts = splitTop(args)
  if (parts.length !== 3) return null
  const a = parts[1].trim().match(/^(.*?)\s+([\d.]+)%$/)
  const ca = parseHex(resolve(a ? a[1] : parts[1], vars))
  const cb = parseHex(resolve(parts[2], vars))
  if (!ca || !cb) return null
  const p = a ? Number(a[2]) / 100 : 0.5
  return toHex(ca.map((v, i) => v * p + cb[i] * (1 - p)))
}

// split on top-level commas
function splitTop(s) {
  const out = []
  let depth = 0, start = 0
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++
    else if (s[i] === ')') depth--
    else if (s[i] === ',' && depth === 0) { out.push(s.slice(start, i)); start = i + 1 }
  }
  out.push(s.slice(start))
  return out
}

// Replace every var(...) and color-mix(...) in an expression with its value
function resolve(expr, vars, depth = 0) {
  if (depth > 20) return expr
  let out = ''
  let i = 0
  while (i < expr.length) {
    const m = expr.slice(i).match(/^(var|color-mix)\(/)
    if (!m) { out += expr[i++]; continue }
    const open = i + m[0].length
    let d = 1, j = open
    while (j < expr.length && d) { if (expr[j] === '(') d++; else if (expr[j] === ')') d--; j++ }
    const inner = expr.slice(open, j - 1)
    if (m[1] === 'var') {
      const [name, ...fb] = splitTop(inner)
      const v = vars.get(name.trim())
      out += v !== undefined ? resolve(v, vars, depth + 1) : fb.length ? resolve(fb.join(','), vars, depth + 1).trim() : ''
    } else {
      out += colorMix(inner, vars) ?? '#888888'
    }
    i = j
  }
  return out
}

function flatten(svg) {
  const vars = new Map()
  // custom properties: on the root's style attribute and in <style> blocks
  for (const m of svg.matchAll(/(--[\w-]+)\s*:\s*([^;"}]+)/g)) vars.set(m[1], m[2].trim())
  const stripped = svg
    .replace(/@import[^;]*;/g, '') // no network fetches; use local fonts
    .replace(/(--[\w-]+)\s*:\s*[^;"}]+;?/g, '') // drop the definitions themselves
  return resolve(stripped, vars)
}

// --- main ---

const input = JSON.parse(readFileSync(0, 'utf8'))
const colors = input.colors ?? {}
const results = []

if (input.mode === 'unicode') {
  for (const { id, src } of input.items ?? []) {
    try {
      const variants = [...new Set(ART_SPACINGS.map(o => tidy(renderMermaidASCII(src, { ...o, useAscii: false, colorMode: 'none' }))))]
      results.push({ id, ok: true, variants })
    } catch (err) {
      results.push({ id, ok: false, error: String(err?.message ?? err).split('\n')[0].slice(0, 300) })
    }
  }
  process.stdout.write(JSON.stringify(results))
  process.exit(0)
}

const { Resvg } = require('@resvg/resvg-js')
mkdirSync(outDir, { recursive: true })
for (const { id, src } of input.items ?? []) {
  try {
    const svg = flatten(renderMermaidSVG(src, { ...colors, font: 'Inter', padding: 16 }))
    const [, w, h] = svg.match(/viewBox="[\d.\-]+ [\d.\-]+ ([\d.]+) ([\d.]+)"/) ?? []
    const png = new Resvg(svg, {
      fitTo: { mode: 'zoom', value: SCALE },
      font: { loadSystemFonts: true, defaultFontFamily: 'Noto Sans', sansSerifFamily: 'Noto Sans' },
      background: colors.bg,
    }).render().asPng()
    writeFileSync(join(outDir, `${id}.png`), png)
    results.push({ id, ok: true, width: Number(w) || 0, height: Number(h) || 0 })
  } catch (err) {
    results.push({ id, ok: false, error: String(err?.message ?? err).split('\n')[0].slice(0, 300) })
  }
}
process.stdout.write(JSON.stringify(results))
