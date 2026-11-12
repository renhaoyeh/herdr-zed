import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

// Icon-only buttons in the provider mods (design.md "Icons and hover"): each one needs an accessibility label and a
// tooltip, so a mouse user and a screen reader both learn what it does. The check reads each button's call chain.
const providers = ['agents', 'github', 'asana', 'mantisbt', 'calendar', 'tasks', 'system', 'simulator'];
const buttonCall = /\b(?:[A-Za-z]*[Bb]utton)\(/g;
const iconOnly = /size: 'icon(?:-sm)?'|\bicon: true\b/g;

// The index just after the parenthesis that closes the one opened at `open`.
function closeIndex(source, open) {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '(') depth++;
    else if (source[i] === ')' && --depth === 0) return i + 1;
  }
  return source.length;
}

// The method names chained onto the button call that contains `index`: Button(...).a(...).b(...)
function chainAt(source, index) {
  const starts = [...source.slice(0, index).matchAll(buttonCall)];
  const start = starts.at(-1);
  if (!start) return null;
  let position = closeIndex(source, start.index + start[0].length - 1);
  const names = [];
  // A chain may continue on the next line, so whitespace between the calls is skipped.
  for (;;) {
    const next = source.slice(position, position + 200).match(/^\s*\.([A-Za-z_]\w*)\(/);
    if (!next) break;
    names.push(next[1]);
    position = closeIndex(source, position + next[0].length - 1);
  }
  return names;
}

test('every icon-only button in the provider mods has an accessibility label and a tooltip', async () => {
  let checked = 0;
  const problems = [];
  for (const id of providers) {
    const dir = new URL(`../mods/herdr-zed-${id}/`, import.meta.url);
    const files = (await readdir(dir)).filter(name => name.endsWith('.js'));
    for (const name of files) {
      const source = await readFile(new URL(name, dir), 'utf8');
      for (const match of source.matchAll(iconOnly)) {
        const chain = chainAt(source, match.index);
        if (!chain) continue;
        checked++;
        const line = source.slice(0, match.index).split('\n').length;
        if (!chain.includes('accessibility_label')) problems.push(`${id}/${name}:${line} has no accessibility_label`);
        if (!chain.includes('tooltip')) problems.push(`${id}/${name}:${line} has no tooltip`);
      }
    }
  }
  assert.ok(checked >= 29, `the audit reads the icon-only buttons (${checked} found)`);
  assert.deepEqual(problems, []);
});
