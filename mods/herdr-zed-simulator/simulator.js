import { div, svg, image } from 'gpui-kit';
import { h_flex, v_flex } from 'gpui-base';
import { exec, run, theme, appHome, shared, setShared, layout, props, openOverlay, closeOverlay, window } from 'herdr';
import { WebSocket } from 'websocket';
import net from 'net';
import { writeFile } from 'fs/promises';
import { DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from './components/dropdown-menu.js';
import { Button } from './components/button.js';

// The live iOS Simulator panel, adapted from herdr-sim (github.com/wobsoriano/herdr-sim, MIT). It is its own mod so a
// extension without the simulator surface leaves it out entirely; components/ holds copies of the shared components it uses.
// serve-sim streams the simulator as MJPEG and takes input over a WebSocket; it runs locally only.
// A login shell resolves the same Node as the user's terminals.
const SERVE_SIM = "SERVE_SIM_DISABLE_DEVICE_HUB_KEYBOARD=1 exec \"${SHELL:-/bin/zsh}\" -lic 'npx --yes serve-sim@0.1.49 \"$@\"' serve-sim \"$@\"";
const DEVICE = 'herdr-zed.simulator-device';
const BOOTING = 'herdr-zed.simulator-booting';
const REPAIR = 'herdr-zed.simulator-repair';
// Frames are written into a separate mod folder: a write inside this mod would reload it. A changed
// image shows blank while it reloads (~175ms), so frames rotate through a ring stacked under the one
// on show, each rising to the top once it has reloaded.
const FRAMES = 'mods/herdr-zed-sim-frames';
const RING = 12, RELOAD_MS = 200, FRAME_MS = 33, CHECK_MS = 2000;
const TOOLBAR = 28, BEZEL = 10, PAD = 12, LINE = 20, CONSUMER = 12;
const TAG = { touch: 0x03, button: 0x04, key: 0x06, rotate: 0x07, scroll: 0x0b, keyboard: 0x0c };
const ROTATE = { portrait: 'landscape_left', landscape_left: 'portrait_upside_down', portrait_upside_down: 'landscape_right', landscape_right: 'portrait' };
const glyph = (name, size = 14) => svg(`mods/herdr-zed/assets/icons/${name}.svg`).size(size).flex_none();
const sleep = (cx, ms) => new Promise(resolve => cx.timer.after(ms, () => resolve()));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const DAY = 86400000;
// Matches Xcode storage's labels in the herdr-zed-simulator mod.
const lastUsedLabel = (value, now = Date.now()) => {
  const days = Math.floor((now - value) / DAY);
  return days < 1 ? 'Today' : days === 1 ? 'Yesterday' : days < 60 ? `${days} days ago` : `${Math.floor(days / 30)} months ago`;
};

// A touch starting in the bottom 7% is the home-indicator edge, so a swipe up from there goes home.
export const touchEdge = p => (p.y >= 0.93 ? 3 : 0);

// gpui key names -> USB HID keyboard usages.
const USAGES = {
  enter: 40, escape: 41, backspace: 42, tab: 43, space: 44,
  '-': 45, '=': 46, '[': 47, ']': 48, '\\': 49, ';': 51, "'": 52, '`': 53, ',': 54, '.': 55, '/': 56,
  home: 74, pageup: 75, delete: 76, end: 77, pagedown: 78, right: 79, left: 80, down: 81, up: 82,
};
for (let i = 0; i < 26; i++) USAGES[String.fromCharCode(97 + i)] = 4 + i;
for (let i = 0; i < 10; i++) USAGES['1234567890'[i]] = 30 + i;
const UNSHIFTED = {
  '!': '1', '@': '2', '#': '3', $: '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0',
  _: '-', '+': '=', '{': '[', '}': ']', '|': '\\', ':': ';', '"': "'", '~': '`', '<': ',', '>': '.', '?': '/',
};
const MODIFIERS = [['control', 224], ['shift', 225], ['alt', 226]];

// HID usages for a key event; null for keys the device ignores and for Cmd chords, which stay Herdr's.
export function keyUsages(event) {
  if (event.modifiers.platform) return null;
  let key = event.key, shift = event.modifiers.shift;
  if (UNSHIFTED[key]) [key, shift] = [UNSHIFTED[key], true];
  if (/^[A-Z]$/.test(key)) [key, shift] = [key.toLowerCase(), true];
  const usage = USAGES[key];
  if (!usage) return null;
  const held = { ...event.modifiers, shift };
  return { usage, modifiers: MODIFIERS.filter(([name]) => held[name]).map(([, code]) => code) };
}

// `xcrun simctl list devices available -j` -> iOS simulators, most recently used first; never-used ones
// follow by newest runtime, then name.
export function parseSimulators(json) {
  return Object.entries(JSON.parse(json).devices).flatMap(([key, devices]) => {
    const m = /SimRuntime\.iOS-(\d+)-(\d+)/.exec(key);
    return m ? devices.map(d => ({ id: d.udid, name: d.name, os: `iOS ${m[1]}.${m[2]}`, booted: d.state === 'Booted',
      lastUsed: Date.parse(d.lastUsedAt) || 0 })) : [];
  }).sort((a, b) => b.lastUsed - a.lastUsed || b.os.localeCompare(a.os, undefined, { numeric: true }) || a.name.localeCompare(b.name));
}

// The chosen simulator, else the first booted one.
export const targetDevice = (devices, chosen) => devices.find(d => d.id === chosen) ?? devices.find(d => d.booted) ?? null;

// Width over height from a JPEG's start-of-frame.
export function jpegAspect(bytes) {
  for (let i = 2; i + 9 < bytes.length;) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1];
    if (marker >= 0xc0 && marker <= 0xc3) return ((bytes[i + 7] << 8) | bytes[i + 8]) / ((bytes[i + 5] << 8) | bytes[i + 6]);
    i += 2 + ((bytes[i + 2] << 8) | bytes[i + 3]);
  }
  return null;
}

function headerEnd(buf, len) {
  for (let i = 0; i + 3 < len; i++) if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) return i;
  return -1;
}

async function serveSim(args) {
  const r = await exec('sh', ['-c', SERVE_SIM, 'sh', ...args]);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split('\n').pop() || 'serve-sim failed');
  return r.stdout.trim().split('\n').findLast(line => line.startsWith('{')) ?? '{}';
}

export async function listSimulators() {
  const r = await exec('xcrun', ['simctl', 'list', 'devices', 'available', '-j']);
  if (r.code !== 0) throw new Error(r.stderr.trim() || 'Xcode simulators are unavailable.');
  return parseSimulators(r.stdout);
}

// Reuses a helper already serving this device; otherwise starts one and owns it.
async function startHelper(device) {
  const listed = JSON.parse(await serveSim(['--list', '-q', device.id]));
  const running = listed.running ? (listed.streams ?? [listed]).find(s => s.device === device.id) : null;
  const helper = running ?? JSON.parse(await serveSim(['--detach', '-q', device.id]));
  const url = new URL(helper.streamUrl);
  const base = helper.streamUrl.replace(/\/stream\.mjpeg$/, '');
  return { device, host: url.hostname, port: Number(url.port), path: url.pathname, preview: previewUrl(helper.streamUrl, device.id), owned: !running, input: new Input(base) };
}

// serve-sim's own 60 FPS browser preview of one device, served by the same helper. chrome=1 keeps the
// device frame even if another preview window stored the frameless choice for this origin.
export const previewUrl = (streamUrl, id) => `${new URL(streamUrl).origin}/?device=${encodeURIComponent(id)}&chrome=1`;

// Herdr cannot embed a web view, so smooth interaction opens the preview in a Chrome app window
// (no address bar), or the default browser without Chrome.
// Whether something other than Herdr and the helper (node) holds a connection to the helper,
// such as the Chrome preview window. One lsof call; it needs no Automation permission.
export async function externalClient(host, port) {
  const r = await exec('lsof', ['-nP', `-iTCP@${host}:${port}`, '-sTCP:ESTABLISHED', '-Fc']);
  return r.stdout.split('\n').some(line => line.startsWith('c') && !['Herdr', 'node'].includes(line.slice(1)));
}

export async function openPreviewWindow(url) {
  const chrome = await exec('open', ['-na', 'Google Chrome', '--args', `--app=${url}`, '--window-size=440,940']);
  if (chrome.code !== 0) await exec('open', [url]);
}

// Bodies are ASCII JSON after a one-byte tag.
function frame(tag, body) {
  const json = body === undefined ? '' : JSON.stringify(body);
  const bytes = new Uint8Array(json.length + 1);
  bytes[0] = tag;
  for (let i = 0; i < json.length; i++) bytes[i + 1] = json.charCodeAt(i);
  return bytes;
}

// One ordered /ws connection per helper; a dropped socket reconnects once. Points are 0..1 of the screen.
export class Input {
  constructor(base) { this.base = base; this.socket = null; this.closed = false; this.queue = Promise.resolve(); this.send(null); }
  send(tag, body) {
    this.queue = this.queue.then(() => this.write(tag == null ? null : frame(tag, body), true))
      .catch(error => console.log(`serve-sim input: ${error.message ?? error}`));
    return this.queue;
  }
  async write(bytes, retry) {
    if (this.closed) return;
    try {
      if (!this.socket) {
        const socket = await WebSocket.connect(`${this.base.replace(/^http/, 'ws')}/ws`);
        if (this.closed) return void socket.close();
        this.socket = socket;
      }
      if (bytes) await this.socket.write(bytes);
    } catch (error) {
      this.socket = null;
      if (!retry) throw error;
      await this.write(bytes, false);
    }
  }
  close() { this.closed = true; this.socket?.close(); this.socket = null; }
  touch(type, p, edge = 0) { return this.send(TAG.touch, edge ? { type, x: p.x, y: p.y, edge } : { type, x: p.x, y: p.y }); }
  button(button) { return this.send(TAG.button, { button }); }
  hid(page, usage) { return this.send(TAG.button, { button: 'hid', page, usage, phase: 'press' }); }
  key(type, usage) { return this.send(TAG.key, { type, usage }); }
  scroll(dx, dy, p) { return this.send(TAG.scroll, { dx, dy, x: p.x, y: p.y }); }
  softwareKeyboard() { return this.send(TAG.keyboard); }
  async rotate() {
    const config = await (await fetch(`${this.base}/config`)).json();
    return this.send(TAG.rotate, { orientation: ROTATE[config.orientation] ?? 'portrait' });
  }
}

const BUTTONS = [
  { id: 'home', icon: 'house', tip: 'Home', press: input => input.button('home') },
  { id: 'lock', icon: 'lock', tip: 'Lock', press: input => input.button('lock') },
  { id: 'volume-down', icon: 'volume-1', tip: 'Volume down', press: input => input.hid(CONSUMER, 234) },
  { id: 'volume-up', icon: 'volume-2', tip: 'Volume up', press: input => input.hid(CONSUMER, 233) },
  { id: 'rotate', icon: 'rotate-ccw', tip: 'Rotate', press: input => input.rotate() },
  { id: 'keyboard', icon: 'keyboard', tip: 'Show or hide the software keyboard', press: input => input.softwareKeyboard() },
];

function fraction(e) {
  const p = e.local_position, b = e.bounds;
  return p && b ? { x: clamp(p.x / b.width, 0, 1), y: clamp(p.y / b.height, 0, 1) } : null;
}

const findNode = (node, id) => node?.id === id ? node : (node?.children ?? []).map(child => findNode(child, id)).find(Boolean) ?? null;
export const simulatorShown = root => { const node = findNode(root, 'simulator'); return Boolean(node && !node.hidden); };

export default class SimulatorPanel {
  init(cx) {
    this.popup = props()?.view === 'simulator-popup';
    // phase: starting | no-device | shutdown | booting | repairing | live | error | unsupported
    this.phase = { kind: 'starting', device: null };
    this.touch = null;
    this.keys = new Map();
    this.devices = [];
    this.frames = Array.from({ length: RING }, (_, i) => `${FRAMES}/frame-${i}.jpg`);
    this.stack = this.frames.map((_, i) => i);
    this.next = 0;
    this.aspect = 1206 / 2622;
    this.size = { width: 380, height: 720 };
    this.focus = cx.focus_handle();
    this.session = null;
    this.socket = null;
    this.closed = false;
    cx.spawn(async cx => {
      // iOS simulators run only on macOS; elsewhere the panel shows and says so instead of streaming.
      // window() can be null while the mod starts or reloads, so wait for the platform rather than
      // mistaking an unknown one for another.
      let platform;
      while (!this.closed && !(platform = window()?.platform)) await sleep(cx, 100);
      if (this.closed) return;
      if (platform !== 'macos') { this.set({ kind: 'unsupported', device: null }, cx); return; }
      await this.run(cx);
    });
  }

  async close() {
    this.closed = true;
    this.socket?.close();
    await this.release();
  }

  async release(kill = false) {
    const session = this.session;
    this.session = null;
    session?.input.close();
    if (session && (session.owned || kill)) await serveSim(['--kill', session.device.id]).catch(() => {});
  }

  target() { return targetDevice(this.devices, shared(DEVICE)); }

  async adopt(sessionPromise) {
    this.session = await sessionPromise;
    if (!this.closed) return true;
    await this.release();
    return false;
  }

  // Pauses while another window (the Chrome preview) shows this device, so it never streams twice.
  // A background lsof refreshes the answer at most every CHECK_MS; the last answer is used meanwhile.
  away(now = Date.now()) {
    const session = this.session;
    if (!session) { this.elsewhere = false; this.checked = 0; return false; }
    if (!this.checking && now - (this.checked ?? 0) >= CHECK_MS) {
      this.checking = true;
      this.checked = now;
      externalClient(session.host, session.port)
        .then(found => { if (this.session === session) this.elsewhere = found; }, () => {})
        .finally(() => { this.checking = false; });
    }
    return this.elsewhere === true;
  }

  set(phase, cx) {
    this.phase = phase;
    if (phase.kind !== 'live') { this.touch = null; this.keys.clear(); }
    cx.notify();
  }

  // The panel copy stays alive while hidden; it stops streaming then.
  async run(cx) {
    while (!this.closed) {
      let device = null;
      try {
        if (!this.popup && !simulatorShown(layout())) { this.socket?.close(); await sleep(cx, 500); continue; }
        if (this.away()) {
          this.socket?.close();
          if (this.phase.kind !== 'elsewhere') this.set({ kind: 'elsewhere', device: this.session.device }, cx);
          await sleep(cx, 500);
          continue;
        }
        this.devices = await listSimulators();
        if (this.closed) return;
        device = this.target();
        if (!device) { this.set({ kind: 'no-device' }, cx); await sleep(cx, 2000); continue; }
        if (!device.booted) {
          this.set({ kind: shared(BOOTING) === device.id ? 'booting' : 'shutdown', device }, cx);
          await sleep(cx, 1000);
          continue;
        }
        if (shared(BOOTING) === device.id) setShared(BOOTING, null);
        if (shared(REPAIR) === device.id) {
          setShared(REPAIR, null);
          this.set({ kind: 'repairing', device }, cx);
          await serveSim(['repair-input', '-d', device.id]);
          if (this.closed) return;
          // A running helper keeps the input it opened before the repair.
          await this.release(true);
        }
        if (this.session?.device.id !== device.id) {
          await this.release();
          if (this.closed) return;
          this.set({ kind: 'starting', device }, cx);
          if (!await this.adopt(startHelper(device))) return;
        }
        await this.stream(cx);
      } catch (error) {
        if (this.closed) return;
        await this.release();
        this.set({ kind: 'error', device, message: String(error.message ?? error) }, cx);
        await sleep(cx, 5000);
      }
    }
  }

  async stream(cx) {
    const { device, host, port, path } = this.session;
    const socket = await net.connect(host, port);
    this.socket = socket;
    // HTTP/1.0 keeps the multipart stream unchunked, so each part's Content-Length is the JPEG.
    await socket.write(`GET ${path} HTTP/1.0\r\nHost: ${host}\r\n\r\n`);
    let buf = new Uint8Array(1 << 20), len = 0, due = 0;
    read: for (;;) {
      // A socket closed elsewhere (another device, a repair, hiding) ends the stream like EOF.
      const chunk = await socket.read(1 << 16).catch(() => null);
      if (chunk == null || this.closed || shared(REPAIR) || this.target()?.id !== device.id) break;
      if (len + chunk.length > buf.length) {
        const grown = new Uint8Array((len + chunk.length) * 2);
        grown.set(buf.subarray(0, len));
        buf = grown;
      }
      buf.set(chunk, len);
      len += chunk.length;
      for (;;) {
        const head = headerEnd(buf, Math.min(len, 4096));
        if (head < 0) break;
        const length = /Content-Length: (\d+)/i.exec(String.fromCharCode(...buf.subarray(0, head)));
        const start = head + 4, end = length ? start + Number(length[1]) : start;
        if (len < end) break;
        const now = Date.now();
        if (length && now >= due) {
          if ((!this.popup && !simulatorShown(layout())) || this.away()) break read;
          due = Math.max(due, now - FRAME_MS) + FRAME_MS;
          // A view, not a copy: buf is only reused after the awaited write, and copies at 30 fps
          // exhaust the mod's memory.
          const bytes = buf.subarray(start, end);
          this.aspect = jpegAspect(bytes) ?? this.aspect;
          const slot = this.next;
          this.next = (slot + 1) % RING;
          await writeFile(`${appHome()}/${this.frames[slot]}`, bytes);
          if (this.phase.kind !== 'live') this.phase = { kind: 'live', device };
          cx.timer.after(RELOAD_MS, cx => { this.stack = [...this.stack.filter(i => i !== slot), slot]; cx.notify(); });
        }
        buf.copyWithin(0, end, len);
        len -= end;
      }
    }
    socket.close();
    this.socket = null;
  }

  lift(p) {
    const touch = this.touch;
    if (!touch) return;
    this.touch = null;
    this.session?.input.touch('end', p ?? touch, touch.edge);
  }

  keyDown(e, cx) {
    const input = this.session?.input, k = input && keyUsages(e);
    if (!k) return;
    cx.stop_propagation();
    // iOS repeats a held key on its own.
    if (this.keys.has(k.usage)) return;
    this.keys.set(k.usage, k.modifiers);
    for (const m of k.modifiers) input.key('down', m);
    input.key('down', k.usage);
  }

  keyUp(e, cx) {
    const input = this.session?.input, k = input && keyUsages(e), modifiers = k && this.keys.get(k.usage);
    if (!modifiers) return;
    cx.stop_propagation();
    this.keys.delete(k.usage);
    input.key('up', k.usage);
    for (const m of [...modifiers].reverse()) input.key('up', m);
  }

  note() {
    const p = this.phase;
    switch (p.kind) {
      case 'live': return null;
      case 'starting': return p.device ? `Connecting to ${p.device.name}…` : 'Starting…';
      case 'repairing': return `Repairing input on ${p.device.name}. SpringBoard restarts and apps close.`;
      case 'booting': return `Booting ${p.device.name}…`;
      case 'shutdown': return `${p.device.name} is shut down. Choose it again to boot it.`;
      case 'no-device': return 'Choose a simulator above';
      case 'error': return p.message;
      case 'elsewhere': return ['Showing in the preview window', 'Close it to show the simulator here.'];
      case 'unsupported': return ['iOS Simulator is not supported here', 'It needs macOS with Xcode.'];
    }
  }

  header(t) {
    const device = this.phase.device ?? this.target();
    const status = this.phase.kind === 'live' ? t.done : this.phase.kind === 'error' ? t.blocked : t.dim;
    // The picker and buttons fill the header's height from its edges, so hover backgrounds are centered and flush.
    const unsupported = this.phase.kind === 'unsupported';
    return h_flex().h(32).flex_none().items_center().border_b(1).border_color(t.border)
      .when(unsupported, el => el.child(div().pl(10).text_color(t.muted).font_medium().child('iOS Simulator')))
      .when(!unsupported, el => el.child(DropdownMenuTrigger(h_flex().id('simulator-device').h_full().min_w(0).pl(10).pr(6).gap(6).items_center()
        .text_color(t.foreground).font_medium().hover(el => el.bg(t.hover)).cursor_pointer(), 280,
        (_cx, at) => openOverlay({ mod: 'herdr-zed-simulator', kind: 'popup', frame: 'none', width: 280, at, props: { view: 'simulator-devices' } }), 'start', { x: 8, y: 9 })
        .child(glyph('circle-check', 12).text_color(status))
        .child(div().min_w(0).truncate().child(device ? `${device.name} · ${device.os}` : 'Choose simulator'))
        .child(glyph('chevron-down', 12).text_color(t.muted))))
      .child(div().flex_1())
      .when(!unsupported, el => el.child(Button('simulator-window', t, { variant: 'ghost', size: 'icon' }).h_full().w(32).accessibility_label('Open in a separate window')
        .tooltip('Open in a separate window for smooth interaction')
        .when(!this.session?.preview, el => el.opacity(0.5))
        .on_click((_e, cx) => { const url = this.session?.preview; if (url) cx.spawn(() => openPreviewWindow(url)); })
        .child(glyph('external-link'))))
      .child(Button('close-simulator', t, { variant: 'ghost', size: 'icon' }).h_full().w(32)
        .accessibility_label(this.popup ? 'Close simulator' : 'Hide simulator')
        .on_click(() => closeSimulator(this.popup)).child(glyph('close')));
  }

  toolbar(t) {
    const live = this.phase.kind === 'live';
    return h_flex().h(TOOLBAR).flex_none().items_center().justify_center().gap(2)
      .children(BUTTONS.map(b => h_flex().id(`simulator-${b.id}`).size(TOOLBAR - 2).flex_none().items_center().justify_center()
        .text_color(live ? t.muted : t.dim).tooltip(b.tip).accessibility_label(b.tip)
        .when(live, el => el.cursor_pointer().hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => { const input = this.session?.input; if (input) cx.spawn(() => b.press(input)); }))
        .when(!live, el => el.opacity(0.5))
        .child(glyph(b.icon))));
  }

  screen(w, h, radius) {
    return div().id('simulator-screen').relative().w(w).h(h)
      .children(this.stack.map(i => image(this.frames[i]).absolute().top(0).left(0).w(w).h(h).rounded(radius)))
      .on_mouse_down('left', e => {
        this.focus.focus();
        const p = fraction(e), input = this.session?.input;
        if (!p || !input) return;
        this.touch = { ...p, edge: touchEdge(p) };
        input.touch('begin', p, this.touch.edge);
      })
      .on_mouse_move(e => {
        const p = fraction(e);
        if (!this.touch || !p) return;
        Object.assign(this.touch, p);
        this.session?.input.touch('move', p, this.touch.edge);
      })
      .on_mouse_up('left', e => this.lift(fraction(e)))
      .on_hover(hovered => { if (!hovered) this.lift(null); })
      .on_scroll_wheel(e => {
        const p = fraction(e), input = this.session?.input;
        if (!p || !input) return;
        const d = e.delta_lines ? { x: e.delta_lines.x * LINE, y: e.delta_lines.y * LINE } : e.delta;
        input.scroll(-d.x / e.bounds.width, -d.y / e.bounds.height, p);
      });
  }

  // Off macOS there is nothing to stream: the header (name and close control) and one muted line, no device frame or toolbar.
  unsupported(t) {
    return v_flex().id('simulator').size_full().bg(t.background).text_size(13).track_focus(this.focus)
      .child(this.header(t))
      .child(v_flex().flex_1().min_h(0).items_center().justify_center().p(PAD)
        .child(div().text_size(12).text_color(t.muted).text_center().child('Needs macOS with Xcode.')));
  }

  render() {
    const t = theme(), note = this.note();
    if (this.phase.kind === 'unsupported') return this.unsupported(t);
    const maxH = this.size.height - 32 - TOOLBAR - 3 * PAD - 2 * BEZEL - 2;
    const maxW = this.size.width - 2 * PAD - 2 * BEZEL - 2;
    const screenH = Math.max(120, Math.min(maxH, maxW / this.aspect));
    const screenW = Math.round(screenH * this.aspect), radius = Math.round(screenW * 0.13);
    const screen = note == null ? this.screen(screenW, screenH, radius)
      : v_flex().w(screenW).h(screenH).rounded(radius).bg('#000000').items_center().justify_center().p(24)
        // A note is one line, or a title and a dimmer detail line.
        .child(v_flex().gap(4).items_center().text_center().text_size(12)
          .child(div().text_color(Array.isArray(note) ? '#d1d1d6' : '#8e8e93').child(Array.isArray(note) ? note[0] : note))
          .when(Array.isArray(note), el => el.child(div().text_color('#8e8e93').child(note[1]))));
    return v_flex().id('simulator').size_full().bg(t.background).text_size(13)
      .track_focus(this.focus)
      .on_key_down((e, cx) => this.keyDown(e, cx))
      .on_key_up((e, cx) => this.keyUp(e, cx))
      .on_size_change((size, cx) => { this.size = size; cx.notify(); })
      .child(this.header(t))
      .child(v_flex().flex_1().min_h(0).p(PAD).gap(PAD)
        .child(this.toolbar(t))
        .child(v_flex().flex_1().items_center().justify_center()
          .child(div().p(BEZEL).rounded(radius + BEZEL).bg('#1c1c1e').border(1).border_color('#3a3a3c').child(screen))));
  }
}

export const toggleSimulator = () => run('layout.toggle', { id: 'simulator' });
export const closeSimulator = popup => popup ? closeOverlay(props()?.overlay) : toggleSimulator();

// The device picker popup: every available simulator, booting the one chosen if it is off.
export class SimulatorMenu {
  init(cx) {
    this.handle = cx.focus_handle(); this.handle.focus();
    this.devices = null;
    cx.spawn(async cx => {
      try { this.devices = await listSimulators(); } catch (error) { this.error = error.message; this.devices = []; }
      cx.notify();
    });
  }

  choose(device) {
    closeOverlay(props().overlay);
    setShared(DEVICE, device.id);
    if (!device.booted) { setShared(BOOTING, device.id); exec('xcrun', ['simctl', 'boot', device.id]); }
  }

  repair(device) {
    closeOverlay(props().overlay);
    setShared(REPAIR, device.id);
  }

  shutdown(device) {
    closeOverlay(props().overlay);
    exec('xcrun', ['simctl', 'shutdown', device.id]);
  }

  // Close the picker before opening the storage dialog in this provider.
  storage() {
    closeOverlay(props().overlay);
    openOverlay({ mod: 'herdr-zed-simulator', kind: 'dialog', frame: 'none', modal: false, width: 0.9, height: 0.86, props: { view: 'simulator-storage' } });
  }

  render() {
    const t = theme();
    const target = this.devices && targetDevice(this.devices, shared(DEVICE));
    // Never-used simulators follow the used ones under their own label.
    const firstUnused = (this.devices ?? []).findIndex(d => !d.lastUsed);
    const rows = (this.devices ?? []).flatMap((d, i) => [...(i === firstUnused && i > 0 ? [DropdownMenuSeparator(t), DropdownMenuLabel(t).child('NEVER USED')] : []), DropdownMenuItem(`simulator-device-${d.id}`, t).h(40)
      .when(d.id === target?.id, el => el.bg(t.selected))
      .on_click(() => this.choose(d))
      .child(v_flex().flex_1().min_w(0)
        .child(h_flex().gap(6).items_center()
          .child(div().min_w(0).truncate().child(d.name))
          .when(d.booted, el => el.child(div().size(6).flex_none().rounded(3).bg(t.done))))
        .child(div().text_size(11).text_color(t.muted).child(d.lastUsed ? `${d.os} · ${lastUsedLabel(d.lastUsed)}` : d.os)))
      .when(d.id === target?.id, el => el.child(glyph('check')))
      // Each booted simulator shuts down from its own row, so two booted ones are never confused.
      .when(d.booted, el => el.child(Button(`simulator-shutdown-${d.id}`, t, { variant: 'row', size: 'icon' })
        .accessibility_label(`Shut down ${d.name}`)
        .on_click((_event, cx) => { cx.stop_propagation(); this.shutdown(d); }).child(glyph('power'))))]);
    const message = this.devices == null ? 'Loading…' : this.error || (!this.devices.length ? 'No simulators. Create one in Xcode.' : null);
    // A scrolling list needs a definite height: rows up to 360px, plus the label, message and actions below.
    const contentHeight = (this.devices ?? []).length * 40 + (firstUnused > 0 ? 9 + 28 : 0), listHeight = Math.min(360, contentHeight);
    const height = 10 + 28 + (message ? 30 : 0) + listHeight + 9 + (target?.booted ? 32 : 0) + 32;
    return DropdownMenuContent('simulator-devices', height, t)
      .track_focus(this.handle)
      .on_key_down(event => { if (event.key === 'escape') closeOverlay(props().overlay); })
      .child(DropdownMenuLabel(t).child('iOS SIMULATORS'))
      .when(Boolean(message), el => el.child(div().px(8).py(6).text_size(12).text_color(t.muted).child(message)))
      // The scrollbar draws over the list's right edge, so an overflowing list keeps a gutter for it.
      .child(v_flex().id('simulator-device-list').flex_1().min_h(0).overflow_y_scrollbar()
        .when(contentHeight > listHeight, el => el.pr(12)).children(rows))
      .child(DropdownMenuSeparator(t))
      .when(Boolean(target?.booted), el => el
        .child(DropdownMenuItem('simulator-repair-input', t).tooltip('For taps that do nothing; restarts SpringBoard and closes apps')
          .on_click(() => this.repair(target))
          .child(div().flex_1().child('Repair input'))
          .child(div().text_size(11).text_color(t.muted).child('restarts SpringBoard'))))
      .child(DropdownMenuItem('simulator-xcode-storage', t).on_click(() => this.storage())
        .child(div().flex_1().child('Xcode storage…')));
  }
}
