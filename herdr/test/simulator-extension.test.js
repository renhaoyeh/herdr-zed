import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { parseExtensionManifest, extensionPopup } from '../mods/devkits-zed/extension-model.js';

const text = await readFile(new URL('../mods/devkits-simulator/extension.json', import.meta.url), 'utf8');

test('simulator declares a panel-sized nonmodal popup for its existing panel view', () => {
  const [action] = parseExtensionManifest('devkits-simulator', text);
  assert.equal(action.id, 'simulator.open');
  assert.deepEqual(extensionPopup(action, null), {
    mod: 'devkits-simulator', kind: 'dialog', frame: 'none', modal: false, width: 480, height: 760,
    props: { view: 'simulator-popup', stateKey: 'devkits-zed.extension.simulator.["",""]' },
  });
});

test('simulator declares the existing panel as its right dock surface', () => {
  const manifest = JSON.parse(text);
  assert.deepEqual(manifest.surfaces, [{ id: 'simulator', location: 'dock.right', view: 'simulator', title: 'iOS Simulator', icon: 'smartphone' }]);
});

test('simulator extension icon resolves to a canonical Devkits icon asset', async () => {
  const [action] = parseExtensionManifest('devkits-simulator', text);
  await access(new URL(`../mods/devkits/assets/icons/${action.icon}.svg`, import.meta.url));
});

test('popup close dismisses its overlay while the original panel close still toggles its block', async () => {
  const source = await readFile(new URL('../mods/devkits-simulator/simulator.js', import.meta.url), 'utf8');
  const code = source.replace(/^import .*;\r?\n/gm, '').replace('export default class', 'class').replace(/^export /gm, '')
    + '\nreturn { closeSimulator };';
  const calls = [];
  const closeOverlay = id => calls.push(['close', id]);
  const run = (...args) => calls.push(args);
  const props = () => ({ overlay: 'popup-id' });
  const { closeSimulator } = new Function('closeOverlay', 'run', 'props', code)(closeOverlay, run, props);
  closeSimulator(true);
  closeSimulator(false);
  assert.deepEqual(calls, [['close', 'popup-id'], ['layout.toggle', { id: 'simulator' }]]);
});

test('closing while helper startup is pending releases the late owned session', async () => {
  const source = await readFile(new URL('../mods/devkits-simulator/simulator.js', import.meta.url), 'utf8');
  const code = source.replace(/^import .*;\r?\n/gm, '').replace('export default class', 'class').replace(/^export /gm, '')
    + '\nreturn { SimulatorPanel };';
  const calls = [];
  const { SimulatorPanel } = new Function('exec', 'props', 'setShared', 'shared', 'layout', 'run', 'theme', 'appHome', 'openOverlay', 'closeOverlay', 'window',
    code)(async (...args) => { calls.push(args); return { code: 0, stdout: '{}' }; }, () => ({}), () => {}, () => {}, () => ({}), () => {}, () => ({}), () => '', () => {}, () => {}, () => ({}));
  let resolveSession;
  const panel = new SimulatorPanel();
  const attempt = panel.adopt(new Promise(resolve => { resolveSession = resolve; }));
  await panel.close();
  resolveSession({ device: { id: 'device-1' }, owned: true, input: { close: () => calls.push(['input.close']) } });
  assert.equal(await attempt, false);
  assert.equal(panel.session, null);
  assert.deepEqual(calls[0], ['input.close']);
  assert.equal(calls[1][0], 'sh');
  assert.deepEqual(calls[1][1].slice(3), ['--kill', 'device-1']);
});
