import { test, expect } from 'claude-code/testing'

const render = async ($: any, id: string, text: string) => JSON.stringify(await $.ui.render({
  surface: 'terminal', component: 'AssistantMessage', requestId: id,
  props: { text, isFirstOfReply: true },
} as any))

test('consecutive lines of one paragraph stay separate lines', async ($, on) => {
  on('ui.render', { component: 'AssistantMessage' }, () => null as any)
  const json = await render($, 's1',
    '📄 Übergabe → file:///home/mb/a.md\n📄 Bootloader → file:///home/mb/b.md\n📄 Memory → file:///home/mb/c.md')
  // each line is its own string in the tree — never space-joined into one
  expect(json).toContain('"📄 Übergabe → file:///home/mb/a.md"')
  expect(json).toContain('"📄 Bootloader → file:///home/mb/b.md"')
  expect(json).toContain('"📄 Memory → file:///home/mb/c.md"')
  expect(json).not.toContain('a.md 📄')
  // a "\n" separator child stands between each adjacent pair of lines
  const [first, second, third] = json.split('"\\n"')
  expect(first).toContain('a.md')
  expect(first).not.toContain('b.md')
  expect(second).toContain('b.md')
  expect(second).not.toContain('c.md')
  expect(third).toContain('c.md')
})

test('inline formatting still works on each line of a multi-line paragraph', async ($, on) => {
  on('ui.render', { component: 'AssistantMessage' }, () => null as any)
  const json = await render($, 's2', 'run `foo()` now\nthen **bold** end\nplain line')
  expect(json).toContain('#e0a458') // code colour
  expect(json).toContain('"foo()"')
  expect(json).toContain('"bold"')
  expect(json).toContain('"plain line"')
  expect(json).not.toContain('now then')
  expect(json).not.toContain('end plain')
  // a "\n" separator child stands between each adjacent pair of lines
  const [first, second, third] = json.split('"\\n"')
  expect(first).toContain('"foo()"')
  expect(first).not.toContain('"bold"')
  expect(second).toContain('"bold"')
  expect(second).not.toContain('"plain line"')
  expect(third).toContain('"plain line"')
})
