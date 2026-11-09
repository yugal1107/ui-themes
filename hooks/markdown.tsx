// A small markdown renderer with our own colours, for replies.
// Tables fall back to the engine's Markdown element.

// Filled from the active theme (~/.claude/ui-themes/<name>.json) by register.tsx
export const MD: Record<'code' | 'bold' | 'heading' | 'link' | 'bullet' | 'quote' | 'rule', string> = {
  code: '#e0a458',
  bold: '#f5e6d3',
  heading: '#d97757',
  link: '#d97757',
  bullet: '#d97757',
  quote: '#a8998a',
  rule: '#3a3029',
}

type El = any
type Table = { Box: any; Text: any; Link: any; Code: any; Markdown: any }

// `code`, **bold**, *italic* / _italic_, [text](url)
const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]+\]\([^)\s]+\))|(\*[^*\s][^*\n]*\*)|(\b_[^_\n]+_\b)/g

export function inline(s: string, t: Table, keyBase: string): El[] {
  const { Text, Link } = t
  const out: El[] = []
  let last = 0
  let k = 0
  for (const m of s.matchAll(INLINE)) {
    const at = m.index ?? 0
    if (at > last) out.push(s.slice(last, at))
    const tok = m[0]
    const key = `${keyBase}-${k++}`
    if (m[1]) out.push(<Text key={key} color={MD.code}>{tok.slice(1, -1)}</Text>)
    else if (m[2]) out.push(<Text key={key} bold color={MD.bold}>{tok.slice(2, -2)}</Text>)
    else if (m[3]) {
      const [, label, href] = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/) ?? []
      out.push(/^(https?|file):/.test(href ?? '')
        ? <Link key={key} href={href}><Text color={MD.link} underline>{label}</Text></Link>
        : <Text key={key} color={MD.link} underline>{label}</Text>)
    } else out.push(<Text key={key} italic>{tok.slice(1, -1)}</Text>)
    last = at + tok.length
  }
  if (last < s.length) out.push(s.slice(last))
  return out
}

// tone: colour for plain text (paragraphs, list items); quotes pass MD.quote
export function renderMarkdown(src: string, t: Table, tone?: string): El {
  const { Box, Text, Code, Markdown } = t
  const lines = src.replace(/\s+$/, '').split('\n')
  const blocks: El[] = []
  let i = 0
  const push = (el: El) => blocks.push(
    <Box key={`b${blocks.length}`} marginTop={blocks.length ? 1 : 0} flexDirection="column">{el}</Box>,
  )

  while (i < lines.length) {
    const line = lines[i] ?? ''

    if (!line.trim()) { i++; continue }

    // ```lang fenced code
    const fence = line.match(/^\s*```(\S*)/)
    if (fence) {
      const body: string[] = []
      i++
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i] ?? '')) body.push(lines[i++] ?? '')
      i++
      push(<Code source={body.join('\n')} language={fence[1] || undefined} />)
      continue
    }

    // tables: hand to the engine
    if (/^\s*\|/.test(line)) {
      const rows: string[] = []
      while (i < lines.length && /^\s*\|/.test(lines[i] ?? '')) rows.push(lines[i++] ?? '')
      push(<Markdown text={rows.join('\n')} />)
      continue
    }

    // # headings
    const head = line.match(/^ {0,3}(#{1,6})\s+(.*)$/) // up to 3 spaces of indent, as in markdown
    if (head) {
      push(<Text bold color={MD.heading}>{inline(head[2] ?? '', t, `h${i}`)}</Text>)
      i++
      continue
    }

    // --- rule
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      push(<Text color={MD.rule}>{'─'.repeat(40)}</Text>)
      i++
      continue
    }

    // > quote: plain prose keeps the │ bar (and its line breaks); a quote with structure (list, heading,
    // blank line, code) is markdown again, drawn in a frame in the quote colour
    if (/^\s*>/.test(line)) {
      const q: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i] ?? '')) q.push((lines[i++] ?? '').replace(/^\s*>\s?/, ''))
      const structured = q.length > 1 && q.some(l => !l.trim() || /^(\s*([-*+]|\d+[.)])\s| {0,3}#{1,6}\s|\s*```)/.test(l))
      push(!structured
        ? (
          <Box flexDirection="row">
            <Text color={MD.quote}>│ </Text>
            <Text color={MD.quote}>{q.flatMap((l, n) => [...(n ? ['\n'] : []), ...inline(l.trim(), t, `q${i}-${n}`)])}</Text>
          </Box>
        )
        : (
          <Box borderStyle="round" borderColor={MD.quote} paddingX={1} flexDirection="column">
            {renderMarkdown(q.join('\n'), t, MD.quote)}
          </Box>
        ))
      continue
    }

    // - / * / 1. lists (with nesting by indent)
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const items: El[] = []
      while (i < lines.length) {
        const l = lines[i] ?? ''
        const m = l.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/)
        if (m) {
          const depth = Math.floor((m[1] ?? '').length / 2)
          const marker = /\d/.test(m[2] ?? '') ? (m[2] ?? '') : '•'
          let text = m[3] ?? ''
          i++
          // continuation lines indented under the item
          while (i < lines.length && /^\s{2,}\S/.test(lines[i] ?? '') && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i] ?? '')) {
            text += ' ' + (lines[i++] ?? '').trim()
          }
          items.push(
            <Box key={`li${i}`} flexDirection="row" paddingLeft={depth * 2}>
              <Box width={marker.length + 1} flexShrink={0}><Text color={MD.bullet}>{marker}</Text></Box>
              <Box flexGrow={1} flexShrink={1}><Text color={tone}>{inline(text, t, `li${i}`)}</Text></Box>
            </Box>,
          )
        } else break
      }
      push(<Box flexDirection="column">{items}</Box>)
      continue
    }

    // paragraph: join until a blank line or another block starts
    // the first line is always taken, so a line no other rule claims can't stall the loop (#1)
    const para: string[] = []
    while (i < lines.length) {
      const l = lines[i] ?? ''
      if (para.length && (!l.trim() || /^(\s*(```|\||>|([-*+]|\d+[.)])\s)| {0,3}#{1,6}\s)/.test(l))) break
      para.push(l.trim())
      i++
    }
    // soft line breaks stay line breaks, like the host renderer
    push(<Text color={tone}>{para.flatMap((p, n) => [...(n ? ['\n'] : []), ...inline(p, t, `p${i}-${n}`)])}</Text>)
  }

  return <Box flexDirection="column">{blocks}</Box>
}
