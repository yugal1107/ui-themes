import type { EngineInterface, Register } from 'claude-code'

import { MD, renderMarkdown } from './markdown'
import { clearMermaidErrors, drawMermaid, mermaidConfig, parseMode, scheduleMermaid, type MermaidColors } from './mermaid'

// Diagram colours from the active theme
function mermaidColors(): MermaidColors {
  return { bg: theme.reply.bg, fg: MD.bold, accent: MD.heading, line: MD.quote, muted: MD.quote, border: MD.heading }
}

// ~/.claude/ui-themes/mermaid holds `unicode`, `image` or `off`; absent is unicode
async function loadMermaidSetting($: EngineInterface) {
  const f = `${await themesDir($)}/mermaid`
  mermaidConfig.mode = ((await $.fs.exists(f)) && parseMode(await $.fs.read(f))) || 'unicode'
}

// Themes live in ~/.claude/ui-themes/<name>.json and the active name in ~/.claude/ui-themes/active.
// The built-in themes and the status line script are copied there on first start and never
// overwritten. When a plugin update ships a different status line script, the person is told and
// applies it with `/ui-theme statusline update` (#2). The status line script reads the same files.

type Theme = {
  name: string
  prompt: { bg: string }
  reply: { bg: string }
  markdown: Partial<typeof MD>
}

const theme: Theme = {
  name: 'claude-warm',
  prompt: { bg: '#4a2a1c' },
  reply: { bg: '#1a1a1a' },
  markdown: {},
}

let dir = ''

// Windows has no HOME; the home folder is in USERPROFILE (#4). With neither set, stop rather
// than write to the root of the current drive; the built-in theme still renders.
async function themesDir($: EngineInterface) {
  if (!dir) {
    const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE'))
    if (!home) throw new Error('no home folder: neither HOME nor USERPROFILE is set')
    dir = `${home}/.claude/ui-themes`
  }
  return dir
}

// Copy built-in themes and the status line script if missing; never overwrite the person's copies.
async function seed($: EngineInterface) {
  const d = await themesDir($)
  const shipped = `${$.plugin.root}/themes`
  for (const f of await $.fs.list(shipped)) {
    if (f.name.endsWith('.json') && !(await $.fs.exists(`${d}/${f.name}`))) {
      await $.fs.write(`${d}/${f.name}`, await $.fs.read(`${shipped}/${f.name}`))
    }
  }
  if (!(await $.fs.exists(`${d}/statusline.sh`))) await installStatusline($)
  if (!(await $.fs.exists(`${d}/active`))) await $.fs.write(`${d}/active`, 'claude-warm\n')
}

// --- status line script: installed once, updated only on request (#2) ---

// The marker holds a hash of the shipped script last installed, so an update is told apart
// from the person's own edits to their copy.
const MARKER = '.statusline.installed'

function hash(text: string) {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0
  return h.toString(16)
}

async function pluginVersion($: EngineInterface) {
  try { return (JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: string }).version ?? '?' } catch { return '?' }
}

async function shippedStatusline($: EngineInterface) {
  return await $.fs.read(`${$.plugin.root}/statusline/statusline.sh`)
}

async function installStatusline($: EngineInterface) {
  const d = await themesDir($)
  const text = await shippedStatusline($)
  await $.fs.write(`${d}/statusline.sh`, text)
  await $.fs.write(`${d}/${MARKER}`, hash(text) + '\n')
}

// 'none': nothing to do; 'available': the plugin ships a script the person hasn't applied yet
async function statuslineUpdate($: EngineInterface): Promise<'none' | 'available'> {
  const d = await themesDir($)
  const shipped = hash(await shippedStatusline($))
  if (await $.fs.exists(`${d}/${MARKER}`)) {
    return (await $.fs.read(`${d}/${MARKER}`)).trim() === shipped ? 'none' : 'available'
  }
  // no marker yet (installed by an older version): identical copy → record it silently
  const current = (await $.fs.exists(`${d}/statusline.sh`)) ? hash(await $.fs.read(`${d}/statusline.sh`)) : ''
  if (current === shipped) {
    await $.fs.write(`${d}/${MARKER}`, shipped + '\n')
    return 'none'
  }
  return 'available'
}

// Line counts of what an update changes, without a full diff
function changeSummary(before: string, after: string) {
  const a = before.split('\n'), b = after.split('\n')
  const inA = new Set(a), inB = new Set(b)
  return { added: b.filter(l => !inA.has(l)).length, removed: a.filter(l => !inB.has(l)).length }
}

async function load($: EngineInterface, name?: string) {
  const d = await themesDir($)
  const active = (name ?? (await $.fs.read(`${d}/active`))).trim()
  const t = JSON.parse(await $.fs.read(`${d}/${active}.json`)) as Theme
  Object.assign(theme, t)
  Object.assign(MD, t.markdown)
  return active
}

async function themeNames($: EngineInterface) {
  return (await $.fs.list(await themesDir($)))
    .map(f => f.name)
    .filter(n => n.endsWith('.json'))
    .map(n => n.slice(0, -5))
    .sort()
}

async function applyTheme($: EngineInterface, name: string) {
  await load($, name)
  await $.fs.write(`${await themesDir($)}/active`, name + '\n')
  $.ui.invalidate('ui.render')
}

const PICKER = 'ui-theme-picker'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      await seed($)
      await load($)
    } catch {}
    try { await loadMermaidSetting($) } catch {}
    try {
      if ((await statuslineUpdate($)) === 'available') {
        $.ui.toast(`ui-themes ${await pluginVersion($)} has a new status line script. Run /ui-theme statusline update to review and apply it.`)
      }
    } catch {}
    $.ui.invalidate('ui.render')
    await $.command.register({
      name: 'ui-theme',
      description: 'Switch the UI theme (message boxes, reply colours, status line)',
      argumentHint: '[name | next | list | statusline [update] | mermaid [unicode|image|off]]',
    })
    return next(e)
  })

  on('command.run', { command: 'ui-theme' }, async ($, e) => {
    try {
      const d = await themesDir($)
      const names = await themeNames($)
      const list = names.map(n => (n === theme.name ? `**${n}**` : `\`${n}\``)).join(' · ')
      let want = e.args.trim()
      if (!want) {
        // no name: open a picker the person moves through with the arrow keys
        await $.ui.open({ id: PICKER, title: 'UI theme', focus: true, closeOnEscape: true, rows: names.length + 4 })
        return {}
      }
      if (want === 'list') {
        return { text: `Theme: **${theme.name}**\n\n${list}\n\n\`/ui-theme\` to pick from a list, \`/ui-theme <name>\` to switch, \`/ui-theme next\` to cycle, \`/ui-theme statusline\` to set up the matching status line, \`/ui-theme mermaid unicode|image|off\` for Mermaid diagrams.\nAdd your own by copying a file in \`${d}\`.` }
      }
      if (want === 'mermaid' || want.startsWith('mermaid ')) {
        const arg = want.slice('mermaid'.length).trim()
        if (arg) {
          const mode = parseMode(arg)
          if (!mode) return { text: `No Mermaid mode \`${arg}\`. Use \`unicode\`, \`image\` or \`off\`.` }
          mermaidConfig.mode = mode
          await $.fs.write(`${d}/mermaid`, mode + '\n')
          clearMermaidErrors()
          $.ui.invalidate('ui.render')
        }
        return { text: `Mermaid diagrams: **${mermaidConfig.mode}**.\n\n- \`unicode\`: box-drawing art in the theme colours, any terminal\n- \`image\`: pictures, in terminals with the kitty graphics protocol (Ghostty, kitty); inside a multiplexer Claude Code may need \`CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1\`\n- \`off\`: plain code blocks\n\n\`/ui-theme mermaid unicode|image|off\` to switch.` }
      }
      if (want === 'next') want =names[(names.indexOf(theme.name) + 1) % names.length] ?? theme.name
      if (want === 'statusline' || want === 'statusline update') {
        const installed = `${d}/statusline.sh`
        const state = await statuslineUpdate($)
        if (want === 'statusline') {
          const pending = state === 'available'
            ? `\n\n**Update available:** ui-themes ${await pluginVersion($)} ships a different script. Run \`/ui-theme statusline update\` to review and apply it.`
            : ''
          return { text: `To use the themed status line, add this to \`~/.claude/settings.json\`:\n\n\`\`\`json\n"statusLine": { "type": "command", "command": "bash ${installed}" }\n\`\`\`\n\nIt needs \`jq\` and looks best with a Nerd Font. Plugin updates never change this file on their own.${pending}` }
        }
        if (state === 'none') return { text: `Your status line script is up to date (\`${installed}\`).` }
        const before = (await $.fs.exists(installed)) ? await $.fs.read(installed) : ''
        const after = await shippedStatusline($)
        const { added, removed } = changeSummary(before, after)
        if (before) await $.fs.write(`${installed}.bak`, before)
        await installStatusline($)
        return { text: `Status line script updated to the version in ui-themes ${await pluginVersion($)}: ${added} line(s) added, ${removed} removed.${before ? `\n\nYour previous copy is saved as \`${installed}.bak\`.` : ''}\nReview it any time: \`${installed}\`` }
      }
      if (!names.includes(want)) {
        return { text: `No theme \`${want}\`. Available: ${list}` }
      }
      await applyTheme($, want)
      return { text: `Theme switched to **${want}**. The status line follows on its next refresh.` }
    } catch (err) {
      return { text: `Theme error: ${String(err)}` }
    }
  })

  // The picker: one row per theme with its description; Enter applies it, Esc closes
  on('ui.render', { component: 'Pane', requestId: PICKER }, async ($, e) => {
    if (e.surface === 'mobile') {
      const { Text } = $.ui.resolve(e)
      return <Text>Themes: {(await themeNames($)).join(', ')}. Use {'/ui-theme <name>'} to switch.</Text>
    }
    const { Box, Text, Select } = $.ui.resolve(e)
    const d = await themesDir($)
    const options = []
    for (const n of await themeNames($)) {
      let about = ''
      try { about = (JSON.parse(await $.fs.read(`${d}/${n}.json`)) as { description?: string }).description ?? '' } catch {}
      options.push({ value: n, label: about ? `${n}  —  ${about}` : n })
    }
    return (
      <Box flexDirection="column" paddingX={1}>
        <Select
          key="theme"
          autoFocus
          options={options}
          value={theme.name}
          onSelect={async (value: string) => {
            await applyTheme($, value)
            await $.ui.close({ id: PICKER })
            $.ui.toast(`Theme: ${value}`)
          }}
        />
        <Text dimColor>↑/↓ to choose · Enter to apply · Esc to close</Text>
      </Box>
    )
  })

  // Your prompts: padded box in the theme's prompt colour
  on('ui.render', { component: 'UserMessage' }, ($, e, next) => {
    // skip task notifications and messages from other agents; style everything you sent (live or resumed)
    if (e.props.task || e.props.from) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box backgroundColor={theme.prompt.bg} paddingX={2} paddingY={1} marginTop={1}>
        <Text>{e.props.text}</Text>
      </Box>
    )
  })

  // Claude's replies: padded box in the theme's reply colour, markdown in theme colours,
  // ```mermaid fences as Unicode art or images (`/ui-theme mermaid`)
  on('ui.render', { component: 'AssistantMessage' }, ($, e) => {
    const t = $.ui.resolve(e)
    const { Box } = t
    const colors = mermaidColors()
    const requests: Array<{ id: string; src: string }> = []
    // room inside the box: its padding, and the transcript's indent around a reply
    const available = (e.viewport?.columns ?? 80) - 6
    const mode = mermaidConfig.mode
    const mermaid = mode !== 'off'
      ? (src: string, closed: boolean) => drawMermaid(t as any, src, closed, colors, available, requests, mode)
      : undefined
    const tree = (
      <Box backgroundColor={theme.reply.bg} paddingX={2} paddingY={1} marginTop={1}>
        {renderMarkdown(e.props.text, t, undefined, { mermaid })}
      </Box>
    )
    if (requests.length) scheduleMermaid($, requests, colors, mode)
    return tree
  })
}
