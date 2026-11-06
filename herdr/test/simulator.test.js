import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function load(host = {}) {
  const source = await readFile(new URL('../mods/devkits-simulator/simulator.js', import.meta.url), 'utf8');
  return new Function(...Object.keys(host), source.replace(/^import .*;\n/gm, '')
    .replace('export default class', 'class').replace(/^export /gm, '')
    + '\nreturn { keyUsages, parseSimulators, targetDevice, jpegAspect, touchEdge, simulatorShown, listSimulators, previewUrl, openPreviewWindow, externalClient, SimulatorPanel, SimulatorMenu };')(...Object.values(host));
}

test('simulator keys map to HID usages, shifting symbols and leaving Cmd chords to Herdr', async () => {
  const { keyUsages } = await load();
  const key = (key, modifiers = {}) => keyUsages({ key, modifiers });
  assert.deepEqual(key('a'), { usage: 4, modifiers: [] });
  assert.deepEqual(key('A'), { usage: 4, modifiers: [225] });
  assert.deepEqual(key('!'), { usage: 30, modifiers: [225] });
  assert.deepEqual(key('enter', { control: true }), { usage: 40, modifiers: [224] });
  assert.equal(key('c', { platform: true }), null);
  assert.equal(key('f20'), null);
});

test('simulator list keeps iOS runtimes, newest first, and chooses the picked or first booted device', async () => {
  const { parseSimulators, targetDevice } = await load();
  const devices = parseSimulators(JSON.stringify({ devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-18-6': [{ udid: 'old', name: 'iPhone 16', state: 'Booted' }],
    'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [{ udid: 'b', name: 'iPhone 17 Pro', state: 'Shutdown' }, { udid: 'a', name: 'iPhone 17', state: 'Shutdown' }],
    'com.apple.CoreSimulator.SimRuntime.watchOS-11-0': [{ udid: 'watch', name: 'Watch', state: 'Booted' }],
  } }));
  assert.deepEqual(devices.map(d => [d.id, d.os, d.booted]), [['a', 'iOS 26.0', false], ['b', 'iOS 26.0', false], ['old', 'iOS 18.6', true]]);
  assert.equal(targetDevice(devices, 'b').id, 'b');
  assert.equal(targetDevice(devices, 'gone').id, 'old');
  assert.equal(targetDevice([], null), null);
});

test('simulator reads frame aspect from a JPEG and tags home-indicator touches', async () => {
  const { jpegAspect, touchEdge } = await load();
  // SOI, a 4-byte APP0 segment, then SOF0 with height 2622 and width 1206.
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x0a, 0x3e, 0x04, 0xb6, 0x03]);
  assert.equal(jpegAspect(jpeg), 1206 / 2622);
  assert.equal(jpegAspect(Uint8Array.from([0xff, 0xd8, 0x00])), null);
  assert.equal(touchEdge({ x: 0.5, y: 0.95 }), 3);
  assert.equal(touchEdge({ x: 0.5, y: 0.5 }), 0);
});

test('simulator panel streams only while its layout column is shown', async () => {
  const { simulatorShown } = await load();
  const root = shown => ({ id: 'root', children: [{ id: 'work', children: [{ id: 'simulator', hidden: !shown }] }] });
  assert.equal(simulatorShown(root(true)), true);
  assert.equal(simulatorShown(root(false)), false);
  assert.equal(simulatorShown({ id: 'root', children: [] }), false);
});

test('simulator list reports a missing Xcode instead of an empty picker', async () => {
  const { listSimulators } = await load({ exec: async () => ({ code: 1, stderr: 'xcrun: error: unable to find utility "simctl"\n' }) });
  await assert.rejects(listSimulators(), /unable to find utility/);
});

test('simulator opens serve-sim\'s preview for its device in a Chrome app window, else the default browser', async () => {
  const calls = [];
  let chrome = 0;
  const { previewUrl, openPreviewWindow } = await load({ exec: async (cmd, args) => { calls.push([cmd, ...args]); return { code: args[1] === 'Google Chrome' ? chrome : 0 }; } });
  const url = previewUrl('http://127.0.0.1:3100/helper/ABC-1/stream.mjpeg', 'ABC-1');
  assert.equal(url, 'http://127.0.0.1:3100/?device=ABC-1&chrome=1');
  await openPreviewWindow(url);
  assert.deepEqual(calls, [['open', '-na', 'Google Chrome', '--args', `--app=${url}`, '--window-size=440,940']]);
  calls.length = 0; chrome = 1;
  await openPreviewWindow(url);
  assert.deepEqual(calls.at(-1), ['open', url]);
});

test('simulator counts a preview window as external, but not Herdr or the helper', async () => {
  let output = '';
  const calls = [];
  const { externalClient } = await load({ exec: async (cmd, args) => { calls.push([cmd, ...args]); return { code: 0, stdout: output }; } });
  output = 'p66147\ncHerdr\np15465\ncnode\n';
  assert.equal(await externalClient('127.0.0.1', 3100), false);
  output += 'p49283\ncGoogle\n';
  assert.equal(await externalClient('127.0.0.1', 3100), true);
  assert.deepEqual(calls[0], ['lsof', '-nP', '-iTCP@127.0.0.1:3100', '-sTCP:ESTABLISHED', '-Fc']);
});

test('simulator pauses whenever a preview window is connected, checking at most every two seconds', async () => {
  let external = true, checks = 0;
  const { SimulatorPanel } = await load({
    exec: async () => { checks++; return { code: 0, stdout: external ? 'cHerdr\ncnode\ncGoogle\n' : 'cHerdr\ncnode\n' }; } });
  const panel = Object.assign(new SimulatorPanel(), { session: { host: '127.0.0.1', port: 3100, device: { id: 'a' } } });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  assert.equal(panel.away(10000), false); await settle();
  assert.equal(panel.away(10500), true);
  assert.equal(checks, 1);
  external = false;
  assert.equal(panel.away(11000), true);
  assert.equal(checks, 1);
  panel.away(12000); await settle();
  assert.equal(panel.away(12100), false);
  assert.equal(checks, 2);
  panel.session = null;
  assert.equal(panel.away(20000), false);
});

test('the device menu opens Xcode storage after closing itself', async () => {
  const closed = [], opened = [];
  const { SimulatorMenu } = await load({ props: () => ({ overlay: 'menu' }), closeOverlay: id => closed.push(id), openOverlay: options => opened.push(options) });
  new SimulatorMenu().storage();
  assert.deepEqual(closed, ['menu']);
  assert.equal(opened[0].mod, 'devkits');
  assert.equal(opened[0].props.view, 'xcode-storage');
  assert.equal(opened[0].kind, 'dialog');
});

test('the device list puts the most recently used simulators first and never-used ones last', async () => {
  const { parseSimulators } = await load();
  const devices = parseSimulators(JSON.stringify({ devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-18-6': [{ udid: 'pro16', name: 'iPhone 16 Pro', state: 'Booted', lastUsedAt: '2026-11-06T13:36:10Z' }],
    'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [{ udid: 'air', name: 'iPhone Air', state: 'Shutdown' },
      { udid: 'max', name: 'iPhone 17 Pro Max', state: 'Shutdown', lastUsedAt: '2026-11-02T15:54:36Z' },
      { udid: 'pro17', name: 'iPhone 17 Pro', state: 'Shutdown', lastUsedAt: '2026-11-04T13:04:01Z' }, { udid: 'e', name: 'iPhone 17e', state: 'Shutdown' }],
  } }));
  assert.deepEqual(devices.map(d => d.id), ['pro16', 'pro17', 'max', 'e', 'air']);
});

test('the device menu shuts down the chosen simulator after closing itself', async () => {
  const closed = [], calls = [];
  const { SimulatorMenu } = await load({ props: () => ({ overlay: 'menu' }), closeOverlay: id => closed.push(id),
    exec: async (cmd, args) => { calls.push([cmd, ...args]); return { code: 0 }; } });
  new SimulatorMenu().shutdown({ id: 'ABC', name: 'iPhone 17 Pro' });
  assert.deepEqual(closed, ['menu']);
  assert.deepEqual(calls, [['xcrun', 'simctl', 'shutdown', 'ABC']]);
});
