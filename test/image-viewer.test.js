import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateNative } from './source-harness.js';

async function harness() {
  const nodes = new Map(), images = [], opened = [], notices = [];
  const element = (id) => {
    const data = { handlers: {}, styles: {}, children: [] };
    const el = new Proxy(data, { get(target, key) {
      if (key in target) return target[key];
      if (key === 'when') return (value, fn) => value ? fn(el) : el;
      return (...args) => {
        if (key === 'id') nodes.set(args[0], data);
        else if (key.startsWith('on_')) data.handlers[key] = args.at(-1);
        else if (key === 'child') data.children.push(args[0]);
        else data.styles[key] = args;
        return el;
      };
    } });
    if (id) nodes.set(id, data);
    return el;
  };
  let appZoom = 1, code = 0;
  const { ImageViewer } = await evaluateNative('../components/image-viewer.js', {
    div: () => element(), h_flex: () => element(), v_flex: () => element(),
    image: path => { images.push(path); return element(); }, ToolbarButton: element, glyph: () => element(),
    settings: () => ({ zoom: appZoom }), window: () => ({ platform: 'macos' }),
    exec: async (...args) => { opened.push(args); return { code, stderr: 'failed' }; }, notify: value => notices.push(value),
  }, 'ImageViewer');
  const cx = { notifications: 0, stopped: 0, notify() { this.notifications++; }, stop_propagation() { this.stopped++; },
    focus_handle: () => ({ focus() {} }), spawn(fn) { return fn(cx); } };
  const viewer = new ImageViewer(cx), target = { path: 'data/a.png', file: '/outside/a.png' };
  const render = () => viewer.render('test-image', target, {});
  render();
  nodes.get('test-image-viewport').handlers.on_size_change({ width: 800, height: 600 }, cx);
  nodes.get('test-image-natural-data/a.png').handlers.on_size_change({ width: 1600, height: 1200 }, cx);
  render();
  return { viewer, target, render, nodes, images, opened, notices, cx,
    setAppZoom: value => { appZoom = value; }, setExit: value => { code = value; } };
}

test('fit preserves aspect ratio, actual size is 100%, and each viewer keeps independent state', async () => {
  const h = await harness(), v = h.viewer;
  assert.equal(v.zoom, 568 / 1200);
  h.nodes.get('test-image-minimize').handlers.on_click({}, h.cx);
  assert.equal(v.zoom, 1);
  v.offset = { x: 99999, y: -99999 }; v.clamp();
  assert.deepEqual(v.offset, { x: 416, y: -316 });
  h.render(); assert.equal(v.zoom, 1, 'ordinary redraw keeps zoom');
  const other = await harness(); assert.equal(other.viewer.scale, null);
  h.nodes.get('test-image-maximize').handlers.on_click({}, h.cx);
  assert.equal(v.scale, null); assert.deepEqual(v.offset, { x: 0, y: 0 });
  h.target.path = 'data/b.png'; h.render();
  assert.equal(v.natural, null); assert.equal(v.scale, null);
  assert.equal(h.images.at(-1), 'data/b.png');
});

test('zoom keeps the point under the cursor fixed and stays within limits', async () => {
  const { viewer: v, cx } = await harness();
  v.actual(cx);
  const anchor = { x: 500, y: 400 };
  const pixel = { x: (anchor.x - 400 - v.offset.x) / v.zoom, y: (anchor.y - 300 - v.offset.y) / v.zoom };
  v.setZoom(2, cx, anchor);
  assert.deepEqual(v.offset, { x: -100, y: -100 });
  assert.equal((anchor.x - 400 - v.offset.x) / v.zoom, pixel.x);
  assert.equal((anchor.y - 300 - v.offset.y) / v.zoom, pixel.y);
  v.setZoom(100, cx); assert.equal(v.zoom, 32);
  v.setZoom(0, cx); assert.equal(v.zoom, 0.05);
});

test('wheel, drag, double-click and keyboard controls work at the app zoom and stop at the canvas edge', async () => {
  const h = await harness(), v = h.viewer, cx = h.cx;
  v.actual(cx); h.setAppZoom(2);
  let canvas = h.nodes.get('test-image-controls').handlers;
  canvas.on_mouse_down({ position: { x: 200, y: 200 }, click_count: 1 }, cx);
  canvas.on_mouse_move({ position: { x: 300, y: 240 } }, cx);
  assert.deepEqual(v.offset, { x: 50, y: 20 });
  canvas.on_hover(false, cx); assert.equal(v.drag, null);
  canvas.on_mouse_down({ position: { x: 200, y: 200 }, click_count: 1 }, cx);
  canvas.on_mouse_up({}, cx); assert.equal(v.drag, null);
  const previous = v.zoom;
  canvas.on_scroll_wheel({ delta: { x: 0, y: 100 }, delta_lines: { x: 0, y: 3 }, local_position: { x: 800, y: 600 } }, cx);
  assert.ok(v.zoom > previous);
  canvas.on_mouse_down({ click_count: 2 }, cx); assert.equal(v.scale, null);
  canvas.on_mouse_down({ click_count: 2 }, cx); assert.equal(v.zoom, 1);
  for (const [key, expected] of [['+', 1.25], ['-', 1], ['1', 1], ['0', v.fitScale]]) {
    v.key({ key }, cx); assert.equal(v.zoom, expected);
  }
  v.actual(cx); v.key({ key: 'right' }, cx); assert.equal(v.offset.x, -40);
  v.key({ key: 'down' }, cx); assert.equal(v.offset.y, -40);
  const stopped = cx.stopped; v.key({ key: 'escape' }, cx); assert.equal(cx.stopped, stopped, 'Escape reaches the enclosing dialog');
  h.render();
  h.nodes.get('test-image-viewport').handlers.on_size_change({ width: 2000, height: 2000 }, cx);
  assert.equal(Math.abs(v.offset.x), 0); assert.equal(Math.abs(v.offset.y), 0);
});

test('trackpad scroll pans, while Command/Control scroll zooms directly from fit', async () => {
  const h = await harness(), v = h.viewer, cx = h.cx;
  const canvas = h.nodes.get('test-image-controls').handlers;
  const scroll = (x, y, modifiers = {}, touch_phase = 'moved') => canvas.on_scroll_wheel({
    delta: { x, y }, modifiers, touch_phase, local_position: { x: 500, y: 400 },
  }, cx);
  const fit = v.zoom;
  assert.equal(Boolean(v.canPan), false);
  scroll(30, 60);
  assert.equal(v.scale, null, 'unmodified two-finger scroll never changes zoom');
  assert.equal(Math.abs(v.offset.x), 0); assert.equal(Math.abs(v.offset.y), 0);
  scroll(0, 100, { platform: true });
  assert.ok(v.zoom > fit, 'Command + scroll works before zooming with any button');
  v.fit(cx); scroll(0, 100, { control: true });
  assert.ok(v.zoom > fit, 'Control + scroll works from fit too');
  v.actual(cx); h.setAppZoom(2);
  scroll(80, -40);
  assert.equal(v.zoom, 1); assert.deepEqual(v.offset, { x: 40, y: -20 });
  scroll(20, -10, {}, 'ended');
  assert.deepEqual(v.offset, { x: 50, y: -25 }, 'momentum retains two-axis panning');
  const notifications = cx.notifications;
  scroll(0, 100, { platform: true }, 'cancelled');
  scroll(0, 0);
  assert.equal(cx.notifications, notifications);
  assert.equal(v.zoom, 1);
});

test('the input surface covers the entire canvas above the image at fit and when enlarged', async () => {
  const h = await harness();
  for (const scale of [null, 4]) {
    h.viewer.scale = scale; h.render();
    const viewport = h.nodes.get('test-image-viewport'), controls = h.nodes.get('test-image-controls');
    assert.equal(viewport.children.at(-1).handlers, controls.handlers, 'input is above image content');
    assert.ok('absolute' in controls.styles); assert.ok('inset_0' in controls.styles);
    assert.equal(typeof controls.handlers.on_scroll_wheel, 'function');
    assert.equal('cursor_grab' in controls.styles, Boolean(h.viewer.canPan));
  }
});

test('external open uses the original file and reports launch failures', async () => {
  const h = await harness();
  await h.viewer.open(h.target.file);
  assert.deepEqual(h.opened, [['/usr/bin/open', ['/outside/a.png']]]);
  h.setExit(1); await h.viewer.open(h.target.file);
  assert.equal(h.notices[0].title, 'Could not open image');
});
