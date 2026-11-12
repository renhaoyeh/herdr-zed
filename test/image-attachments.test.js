import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateNative } from './source-harness.js';

const load = () => evaluateNative('../components/image-attachments.js', {}, 'pasteClipboardImage, withAttachments, ATTACHMENTS_DIR');

test('a pasted image is saved under the app data folder and named by an absolute path for the agent', async () => {
  const { pasteClipboardImage, ATTACHMENTS_DIR } = await load();
  const calls = [];
  const services = { window: () => ({ platform: 'windows' }), appHome: () => "C:/Users/O'Neil/.config/herdr-app",
    exec: async (...args) => { calls.push(args); return { code: 0, stdout: '', stderr: '' }; } };
  const item = await pasteClipboardImage(services);
  assert.match(item.path, new RegExp(`^${ATTACHMENTS_DIR}/\\d+-\\w+\\.png$`), 'app-relative, so image() can show it');
  assert.equal(item.file, `C:\\Users\\O'Neil\\.config\\herdr-app\\${item.path.replace(/\//g, '\\')}`);
  const [command, args] = calls[0];
  assert.equal(command, 'powershell.exe');
  assert.ok(args.includes('-STA'), 'the clipboard needs a single-threaded apartment');
  assert.ok(args.at(-1).endsWith(`-file '${item.file.replace(/'/g, "''")}'`), 'the path is a quoted argument, not script text');
});

test('no image on the clipboard is not an error; a failed read and other platforms say why', async () => {
  const { pasteClipboardImage } = await load();
  const windows = (result) => ({ window: () => ({ platform: 'windows' }), appHome: () => '/home', exec: async () => result });
  assert.equal(await pasteClipboardImage(windows({ code: 3, stdout: '', stderr: '' })), null);
  await assert.rejects(pasteClipboardImage(windows({ code: 1, stdout: '', stderr: 'Access denied' })), /Access denied/);
  await assert.rejects(pasteClipboardImage({ window: () => ({ platform: 'macos' }), appHome: () => '/home', exec: async () => assert.fail('no call') }),
    /Windows/);
});

test('attached images follow the prompt as paths; without any the prompt is unchanged', async () => {
  const { withAttachments } = await load();
  assert.equal(withAttachments('Fix it', []), 'Fix it');
  assert.equal(withAttachments('  Fix it  ', [{ file: 'C:\\a.png' }, { file: 'C:\\b.png' }]),
    'Fix it\n\nC:\\a.png\nC:\\b.png');
  assert.equal(withAttachments('', [{ file: 'C:\\a.png' }]), 'C:\\a.png');
});

test('a thumbnail previews its image in a dialog of the mod that shows it', async () => {
  const { openImagePreview, IMAGE_PREVIEW_VIEW } = await evaluateNative('../components/image-attachments.js', {}, 'openImagePreview, IMAGE_PREVIEW_VIEW');
  const opened = [];
  openImagePreview('herdr-zed-tasks', { path: 'data/herdr-zed/attachments/a.png', file: 'C:\\home\\a.png' }, { openOverlay: spec => opened.push(spec) });
  assert.deepEqual(opened, [{ mod: 'herdr-zed-tasks', kind: 'dialog', frame: 'none', width: 0.8, height: 0.85,
    props: { view: IMAGE_PREVIEW_VIEW, path: 'data/herdr-zed/attachments/a.png', file: 'C:\\home\\a.png' } }]);
});

test('the preview opens its image full size in the system viewer', async () => {
  const { viewAttachment } = await evaluateNative('../components/image-attachments.js', {}, 'viewAttachment');
  const calls = [];
  await viewAttachment({ file: 'C:\\home\\a.png' }, { exec: async (...args) => { calls.push(args); return { code: 0 }; } });
  assert.deepEqual(calls, [['explorer.exe', ['C:\\home\\a.png']]]);
});

test('Settings shows how many pasted images are kept and opens their folder', async () => {
  const { attachmentsUsage, openAttachmentsFolder, formatBytes } = await evaluateNative('../components/image-attachments.js', {},
    'attachmentsUsage, openAttachmentsFolder, formatBytes');
  const windows = { window: () => ({ platform: 'windows' }), appHome: () => 'C:/home' };
  assert.deepEqual(await attachmentsUsage({ ...windows, exec: async () => ({ code: 0, stdout: '3 31515\r\n' }) }), { count: 3, bytes: 31515 });
  assert.equal(await attachmentsUsage({ ...windows, exec: async () => ({ code: 1, stdout: '' }) }), null);
  assert.equal(await attachmentsUsage({ window: () => ({ platform: 'macos' }), appHome: () => '/home', exec: async () => assert.fail() }), null);
  const calls = [];
  await openAttachmentsFolder({ appHome: () => 'C:/home', exec: async (...args) => { calls.push(args); return { code: 0 }; } });
  assert.deepEqual(calls.at(-1), ['explorer.exe', ['C:\\home\\data\\herdr-zed\\attachments']], 'the folder is created, then opened');
  assert.equal(formatBytes(31515), '31 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
});
