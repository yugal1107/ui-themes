import { test, expect } from 'claude-code/testing'

test('a multi-line quote keeps its list instead of one flattened line', async ($, on) => {
  on('ui.render', { component: 'AssistantMessage' }, () => null as any)
  const tree = await $.ui.render({
    surface: 'terminal', component: 'AssistantMessage', requestId: 'm2',
    props: { text: '> **Open items**\n>\n> 1. first\n> 2. second', isFirstOfReply: true },
  } as any)
  const json = JSON.stringify(tree)
  expect(json).toContain('"round"')
  // list markers are their own elements, not part of one joined string
  expect(json).toContain('"1."')
  expect(json).toContain('"2."')
})

test('plain multi-line prose keeps the │ bar instead of a frame', async ($, on) => {
  on('ui.render', { component: 'AssistantMessage' }, () => null as any)
  const tree = await $.ui.render({
    surface: 'terminal', component: 'AssistantMessage', requestId: 'm3',
    props: { text: '> This is a longer note that was written\n> across two lines of plain prose.', isFirstOfReply: true },
  } as any)
  const json = JSON.stringify(tree)
  expect(json).toContain('│ ')
  expect(json).not.toContain('"round"')
  // each source line stays its own line, with a "\n" child between them
  const [first, second] = json.split('"\\n"')
  expect(first).toContain('"This is a longer note that was written"')
  expect(second).toContain('"across two lines of plain prose."')
  expect(json).not.toContain('written across')
})

test('a plain quote of short formatted lines keeps one line per item', async ($, on) => {
  on('ui.render', { component: 'AssistantMessage' }, () => null as any)
  const tree = await $.ui.render({
    surface: 'terminal', component: 'AssistantMessage', requestId: 'm4',
    props: { text: '> **Now**\n> **1 · first item** — small\n> why it matters.', isFirstOfReply: true },
  } as any)
  const json = JSON.stringify(tree)
  expect(json).toContain('│ ')
  expect(json).not.toContain('"round"')
  expect(json).not.toContain('small why')
  const [first, second, third] = json.split('"\\n"')
  expect(first).toContain('"Now"')
  expect(second).toContain('"1 · first item"')
  expect(third).toContain('why it matters.')
})
