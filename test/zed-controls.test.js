import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { agentReportedWorking, terminalWorking } from '../components/session-model.js';
import { evaluateNative } from './source-harness.js';

// Icons and hover (design.md, Icons and hover): one ToolbarButton icon variant, one hover treatment, and the pane and row
// spinner rule (review L12).

// Records a button's base style, its hover style (hover callbacks are run), and its handlers.
const styled = () => {
  const node = { attrs: {}, hoverStyle: {}, handlers: {}, calls: [] };
  const proxy = new Proxy(node, { get(target, key) {
    if (key in target) return target[key];
    return (...args) => {
      if (key === 'hover') { const inner = styled(); args[0](inner); target.hoverStyle = { ...target.hoverStyle, ...inner.attrs }; return proxy; }
      if (key === 'when') { if (args[0]) args[1](proxy); return proxy; }
      if (key.startsWith('on_')) { target.handlers[key] = args[0]; return proxy; }
      if (key === 'child' || key === 'children' || key === 'tooltip' || key === 'accessibility_label') { target.calls.push([key, args[0]]); return proxy; }
      target.attrs[key] = args.length === 1 ? args[0] : args.length ? args : true;
      return proxy;
    };
  } });
  return proxy;
};
const nativeButton = { new: id => Object.assign(styled(), { id }) };
const { Button, ToolbarButton, TOOLBAR_GLYPH, ROW_GLYPH } = await evaluateNative('../components/button.js',
  { NativeButton: nativeButton }, 'Button, ToolbarButton, TOOLBAR_GLYPH, ROW_GLYPH');
const t = { hover: 'HOVER', selected: 'SELECTED', muted: 'MUTED', foreground: 'FG', solid: 'SOLID', solid_foreground: 'ON_SOLID',
  border: 'BORDER', input: 'INPUT', control: 'CONTROL', controlBorder: 'CB', solidHover: 'SOLID_HOVER', popover: 'POPOVER', chrome: 'CHROME' };

test('ToolbarButton icon: 28px target with a 16px glyph in bars; 24px with a 14px glyph in rows', () => {
  assert.equal(TOOLBAR_GLYPH, 16); assert.equal(ROW_GLYPH, 14);
  const bar = ToolbarButton('a', t, { icon: true });
  assert.equal(bar.attrs.size, 28);
  assert.equal(bar.attrs.p, 0, 'the glyph is centered without inherited padding');
  assert.equal(bar.attrs.overflow_hidden, true, 'icon content stays inside its target');
  assert.equal(bar.attrs.bg, '#00000000', 'transparent at rest, so the bar behind shows');
  const row = ToolbarButton('b', t, { icon: true, row: true });
  assert.equal(row.attrs.size, 24);
  assert.equal(row.hoverStyle.bg, 'CHROME', 'nested actions deepen against a row using HOVER');
  assert.equal(row.attrs.px, undefined, 'an icon button has no text padding');
  assert.equal(bar.attrs.h_full, undefined, 'an icon button is a square target, not full height');
});

test('shipped hover colors remain visible over focused pane headers in both themes', async () => {
  for (const name of ['devkits', 'devkits-light']) {
    const { colors } = JSON.parse(await readFile(new URL(`../themes/${name}.json`, import.meta.url), 'utf8'));
    assert.notEqual(colors.hover, colors.selected, `${name}: focused pane actions need visible hover feedback`);
    assert.notEqual(colors.hover, colors.chrome, `${name}: unfocused pane actions need visible hover feedback`);
  }
});

test('one hover treatment: the background `hover`, with no border or colour shift', () => {
  const ghost = Button('g', t, { variant: 'ghost' });
  assert.equal(ghost.hoverStyle.bg, 'HOVER');
  assert.equal(ghost.hoverStyle.text_color, undefined, 'no colour shift on hover');
  assert.equal(ghost.hoverStyle.border_color, undefined);
  const secondary = Button('s', t, { variant: 'secondary' });
  assert.equal(secondary.hoverStyle.bg, 'HOVER');
  assert.equal(secondary.hoverStyle.border_color, undefined);
  const outline = Button('o', t, { variant: 'outline' });
  assert.equal(outline.hoverStyle.bg, 'HOVER');
  assert.equal(Button('d', t, { variant: 'default' }).hoverStyle.opacity, 0.9, 'filled buttons dim to 90% instead');
  assert.equal(Button('i', t, { size: 'icon-sm' }).attrs.size, 24, 'icon-small buttons are 24px');
});

test('selected keeps its fill on hover; disabled is 45% and never hovers', () => {
  const selected = ToolbarButton('s', t, { icon: true, selected: true });
  assert.equal(selected.attrs.bg, 'SELECTED');
  assert.equal(selected.hoverStyle.bg, 'SELECTED', 'hovering a selected button keeps the selected fill');
  const disabled = ToolbarButton('x', t, { icon: true, disabled: true });
  assert.equal(disabled.attrs.opacity, 0.45);
  assert.equal(disabled.attrs.disabled, true);
  assert.equal(disabled.hoverStyle.bg, undefined, 'a disabled button has no hover');
  const plain = ToolbarButton('p', t, { icon: true });
  assert.equal(plain.attrs.opacity, 1);
  assert.equal(plain.hoverStyle.bg, 'HOVER');
});

test('a text toolbar action fills the bar height with its own padding', () => {
  const text = ToolbarButton('t', t, {});
  assert.equal(text.attrs.px, 8);
  assert.equal(text.attrs.h_full, true, 'the bar height');
  assert.equal(text.attrs.size, undefined, 'text actions are not square targets');
});

test('the spinner shows only for what an agent reports as working', () => {
  const plainBusy = { status: 'working', argv: ['npm', 'run', 'dev'], program: { name: 'npm' } };
  assert.equal(agentReportedWorking(plainBusy), false, 'a plain terminal running a command is not agent-working');
  assert.equal(agentReportedWorking({ status: 'working', program: { agent: true } }), true, 'an agent reports working');
  assert.equal(agentReportedWorking({ status: 'working', agent: 'codex' }), true);
  assert.equal(agentReportedWorking({ status: 'idle', program: { agent: true } }), false);
  assert.equal(agentReportedWorking({ program: { agent: true } }), false, 'no report, no spinner');
  assert.equal(agentReportedWorking(undefined), false);
  assert.equal(agentReportedWorking({ program: { agent: true } }, 'working'), true, 'an explicit status is checked too');
  // The terminal state helper keeps its foreground detection for other consumers; the spinner no longer uses it.
  assert.equal(terminalWorking({ state: 'live', foreground: { pid: 1, name: 'node', argv: ['node', 'server.js'] } }), true);
});

test('the shipped layout keeps the history row as the sidebar\'s last block, below the surfaces', async () => {
  const layout = JSON.parse(await readFile(new URL('../layouts/herdr-zed.json', import.meta.url), 'utf8'));
  const sidebar = layout.children[0];
  assert.equal(sidebar.id, 'sidebar');
  assert.deepEqual(sidebar.children.map(child => child.id), ['brand', 'agents', 'sidebar-history']);
  const history = sidebar.children.at(-1);
  assert.deepEqual(history.size, { px: 32 });
  assert.deepEqual(history.content, { mod: 'herdr-zed', props: { view: 'sidebar-history' } });
});
