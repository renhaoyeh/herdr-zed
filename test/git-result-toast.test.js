import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('window toast centers across the viewport at any zoom and routes actions without taking focus', async () => {
  const source = await readFile(new URL('../mods/herdr-zed/git-result-toast.js', import.meta.url), 'utf8');
  const store = {}, nodes = new Map();
  let zoom = 1;
  const element = () => {
    const data = { children: [] };
    const el = new Proxy(data, { get: (_target, key) => {
      if (key === 'data') return data;
      if (key === 'when') return (condition, fn) => { if (condition) fn(el); return el; };
      return (...args) => {
        if (key === 'id') nodes.set(args[0], data);
        if (key === 'child') data.children.push(args[0]);
        else data[key] = key === 'content' ? args[0].data : args.length === 1 ? args[0] : args;
        return el;
      };
    } });
    return el;
  };
  const { showGitToast, clearGitToast, GitResultToast } = new Function('div', 'svg', 'h_flex', 'Popup', 'Button', 'ToolbarButton', 'shared', 'setShared', 'settings', 'globalThis',
    source.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '') + '\nreturn { showGitToast, clearGitToast, GitResultToast };')(
    element, element, element, { new: id => element().id(id) }, id => element().id(id), id => element().id(id),
    key => store[key], (key, value) => { store[key] = value; }, () => ({ zoom }),
    { window: { viewport_size: () => ({ width: 1440, height: 900 }) } });
  const project = { folder: '/repo', machine: 'remote' };
  showGitToast(project, 'Fetch completed', false);
  for (const scale of [1, 1.5, 2]) {
    zoom = scale; nodes.clear(); GitResultToast({}, project);
    const layer = nodes.get('git-result-toast-layer');
    assert.equal(layer.anchor, 'bottom_right');
    assert.equal(layer.content.w, 1440 / scale);
    assert.equal(layer.content.pb, 12);
    assert.deepEqual(layer.content.justify_center, []);
    assert.equal(layer.track_focus, undefined);
    assert.equal(nodes.has('git-view-log'), false);
  }
  clearGitToast({ folder: '/other', machine: 'remote' });
  assert.ok(store['herdr-zed.git-result-toast'], 'Closing another project cannot clear this result');
  nodes.clear(); GitResultToast({}, { folder: '/other', machine: 'remote' });
  assert.equal(nodes.has('git-result-toast-layer'), false, 'Results only show in their originating project');
  GitResultToast({}, project);
  nodes.get('git-toast-close').on_click();
  assert.equal(store['herdr-zed.git-result-toast'], null);
  showGitToast(project, 'Fetch failed', true); GitResultToast({}, project);
  nodes.get('git-view-log').on_click();
  assert.equal(store['herdr-zed.git-output-request'], JSON.stringify(['remote', '/repo']));
  assert.equal(store['herdr-zed.right-panel'], 'diff');
  assert.equal(store['herdr-zed.git-result-toast'], null);
});
