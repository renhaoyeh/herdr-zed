import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

async function load(host = {}) {
  const memory = {};
  host = { DropdownMenuState: class { constructor() { this.open = false; } }, shared: key => memory[key], setShared: (key, value) => {
    // Herdr's shared store cuts keys at NUL; round-trip like the persisted file.
    assert.ok(!JSON.stringify(value).includes('\\u0000'), 'persisted keys contain NUL');
    memory[key] = JSON.parse(JSON.stringify(value));
  }, ...host };
  const source = await readFile(new URL('../mods/herdr-zed/files.js', import.meta.url), 'utf8');
  const sidePanel = await readFile(new URL('../components/side-panel.js', import.meta.url), 'utf8');
  const shell = await readFile(new URL('../mods/herdr-zed/shell.js', import.meta.url), 'utf8');
  const command = await readFile(new URL('../components/session-shell.js', import.meta.url), 'utf8');
  return new Function(...Object.keys(host), (command + '\n' + shell + '\n' + sidePanel + '\n' + source).replace(/^import .*;\r?\n/gm, '')
    .replace('export default class', 'class').replace(/^export /gm, '') + '\nreturn { FileViewer, FileMenu, fullPath, revealPath, directory, parseStatus, gitStatus };')(...Object.values(host));
}
const project = { id: 'project', folder: '/project', machine: 'server' };
function timers() {
  const scheduled = [];
  const add = (kind, ms, callback) => {
    const timer = { kind, ms, callback, cancel() { this.cancelled = true; } };
    scheduled.push(timer); return timer;
  };
  return { scheduled, after: (ms, fn) => add('after', ms, fn), every: (ms, fn) => add('every', ms, fn) };
}
async function scenario(readTextFile = async path => path) {
  const tasks = [], editors = [];
  const { FileViewer } = await load({ readTextFile, settings: () => ({}), theme: () => ({}),
    exec: async () => ({ code: 0, stdout: 'f\0main.ts\0d\0src\0', stderr: '' }),
    EditorState: { new(options) { const state = { options, released: false, changes: 0,
      value() { return this.options.value; }, set_value(value) { this.options.value = value; this.changes++; },
      release() { this.released = true; } }; editors.push(state); return state; } } });
  const cx = { timer: timers(), notify() {}, stop_propagation() {}, focus_handle: () => ({ focus() {} }), spawn(fn) { tasks.push(fn(cx)); } };
  const view = new FileViewer(); view.init(cx); view.refresh(project, cx);
  const drain = async () => { while (tasks.length) await Promise.all(tasks.splice(0)); };
  await drain();
  return { view, cx, editors, drain };
}

test('folder listing preserves Unicode and shell metacharacters, skips .git and sorts folders first', async t => {
  const root = await mkdtemp(join(tmpdir(), 'herdr-zed-files-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = join(root, "專案 ' $(touch INJECTED) [test]");
  await mkdir(folder);
  await mkdir(join(folder, '.git'));
  await mkdir(join(folder, 'src'));
  // Windows forbids control characters in filenames; retain shell metacharacter coverage there.
  const unusualName = process.platform === 'win32' ? 'a & b.js' : 'a\nb.js';
  const filenames = ['你好.ts', unusualName, '.env', '$(touch INJECTED).txt'];
  for (const name of filenames) await writeFile(join(folder, name), 'hello');
  await symlink(join(folder, 'src'), join(folder, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const { directory } = await load({ exec: async (cmd, args, options) => {
    assert.equal(options.on, undefined);
    const { stdout, stderr } = await promisify(execFile)(cmd, args);
    return { code: 0, stdout, stderr };
  } });
  const shellFolder = process.platform === 'win32' ? folder.replaceAll('\\', '/') : folder;
  const rows = await directory(shellFolder);
  assert.deepEqual(rows.slice(0, 2).map(row => row.name), ['linked', 'src']);
  assert.deepEqual(rows.filter(row => !row.dir).map(row => row.name).sort(), filenames.sort());
  await assert.rejects(directory(`${shellFolder}/missing`));
});

test('folder expansion is lazy and keyboard navigation opens a read-only syntax preview on the project machine', async () => {
  const reads = [];
  const { view, cx, drain } = await scenario(async (path, options) => { reads.push([path, options]); return 'const a = 1;'; });
  assert.deepEqual(view.rows().map(row => row.path), ['src', 'main.ts']);
  assert.equal(view.entries.size, 1);
  view.navigate({ key: 'down' }, cx);
  view.navigate({ key: 'right' }, cx); await drain();
  assert.equal(view.entries.size, 2);
  view.navigate({ key: 'left' }, cx);
  view.navigate({ key: 'down' }, cx);
  view.navigate({ key: 'enter' }, cx); await drain();
  assert.deepEqual(reads, [['/project/main.ts', { on: 'server' }]]);
  assert.equal(view.code.options.readonly, true);
  assert.equal(view.code.options.soft_wrap, true);
  assert.equal(view.code.options.language, 'js');
  assert.equal(view.code.options.value, 'const a = 1;');
});

test('slow reads cannot replace a later file, survive project changes, or create an editor after close', async () => {
  const replies = [];
  const { view, cx, editors, drain } = await scenario(() => new Promise(resolve => replies.push(resolve)));
  view.show('a.ts', cx); view.show('b.ts', cx);
  replies[1]('new'); replies[0]('old'); await drain();
  assert.equal(view.code.options.value, 'new');
  const previous = view.code;
  view.show('c.ts', cx); view.refresh({ ...project, folder: '/other' }, cx);
  replies[2]('stale project'); await drain();
  assert.equal(view.code, null);
  assert.equal(previous.released, true);
  view.show('d.ts', cx); view.close(); replies[3]('closed'); await drain();
  assert.equal(editors.length, 1);
});

test('tabs reuse one italic preview, pin on double-click, close to the recent tab and return per project', async () => {
  const reads = [];
  const { view, cx, editors, drain } = await scenario(async path => { reads.push(path); return `text of ${path}`; });
  const tabs = () => view.tabs.map(doc => doc.path);
  view.show('a.ts', cx); await drain(); view.show('b.ts', cx); await drain();
  assert.deepEqual(tabs(), ['b.ts']);
  assert.equal(view.preview, 'b.ts');
  assert.equal(editors[0].released, true);
  view.show('b.ts', cx, true); view.show('c.ts', cx); view.show('d.ts', cx); await drain();
  assert.deepEqual(tabs(), ['b.ts', 'd.ts']);
  view.pin('d.ts', cx); view.activate('b.ts', cx); view.show('e.ts', cx); await drain();
  // A new tab opens at the end, not beside the shown one.
  assert.deepEqual(tabs(), ['b.ts', 'd.ts', 'e.ts']);
  assert.equal(view.code.options.value, 'text of /project/e.ts');
  const closed = view.code;
  view.closeTab('e.ts', cx);
  assert.equal(closed.released, true);
  assert.equal(view.file, 'b.ts');
  assert.equal(view.preview, null);
  view.activate('b.ts', cx); view.closeTab('b.ts', cx);
  assert.equal(view.file, 'd.ts');
  view.show('b.ts', cx, true); view.closeTab('d.ts', cx);
  assert.equal(view.file, 'b.ts');

  // Background tabs reread only when shown again after a change.
  view.show('f.ts', cx, true); await drain();
  reads.length = 0; view.reload(cx); await drain();
  assert.deepEqual(reads, ['/project/f.ts']);
  view.activate('b.ts', cx); await drain();
  assert.deepEqual(reads, ['/project/f.ts', '/project/b.ts']);

  view.refresh({ ...project, id: 'other', folder: '/other' }, cx); await drain();
  assert.deepEqual(tabs(), []);
  assert.equal(view.file, null);
  view.refresh(project, cx); await drain();
  assert.deepEqual(tabs(), ['b.ts', 'f.ts']);
  assert.equal(view.file, 'b.ts');
  assert.equal(view.code.options.value, 'text of /project/b.ts');
  assert.equal(view.tabs[1].loaded, false);

  // Tabs survive a mod reload or restart: a new view restores them from shared state.
  view.closeTab('f.ts', cx); view.show('g.ts', cx); await drain();
  const reloaded = new view.constructor(); reloaded.init(cx);
  const notify = cx.notify;
  cx.notify = () => assert.fail('Restoring tabs during render must not request another render synchronously');
  reloaded.refresh(project, cx);
  cx.notify = notify;
  await drain();
  assert.deepEqual(reloaded.tabs.map(doc => doc.path), ['b.ts', 'g.ts']);
  assert.equal(reloaded.file, 'g.ts');
  assert.equal(reloaded.preview, 'g.ts');
  assert.equal(reloaded.code.options.value, 'text of /project/g.ts');
  // Closing every tab forgets the project.
  reloaded.closeTab('b.ts', cx); reloaded.closeTab('g.ts', cx);
  const empty = new view.constructor(); empty.init(cx); empty.refresh(project, cx);
  assert.deepEqual(empty.tabs, []);
});

test('binary, absent and unreadable files show an error; long previews are bounded and refresh rereads', async () => {
  let result = null;
  const { view, cx, drain } = await scenario(async () => { if (result instanceof Error) throw result; return result; });
  for (const [value, message] of [[null, /no longer available/], ['a\0b', /Binary/], [Error('Unreadable'), /Unreadable/]]) {
    result = value; view.show('file.ts', cx); await drain();
    assert.match(view.fileError, message); assert.equal(view.code, null);
  }
  result = 'x'.repeat(400001); view.show('file.ts', cx); await drain();
  assert.ok(view.code.options.value.endsWith('(preview truncated)'));
  result = 'updated'; view.refresh(project, cx); await drain();
  assert.equal(view.code.options.value, 'updated');
});

test('directory failures and entry caps are visible without retaining stale refresh results', async () => {
  const replies = [];
  const { FileViewer } = await load({ exec: (_cmd, args) => args[2] === 'herdr-zed-status' ? Promise.resolve({ code: 0, stdout: '' }) : new Promise(resolve => replies.push(resolve)) });
  const tasks = [], cx = { timer: timers(), notify() {}, focus_handle: () => ({}), spawn(fn) { tasks.push(fn(cx)); } };
  const view = new FileViewer(); view.init(cx);
  view.refresh(project, cx); view.refresh(project, cx);
  replies[1]({ code: 0, stdout: Array.from({ length: 501 }, (_, i) => `f\0file-${i}\0`).join('') });
  replies[0]({ code: 1, stderr: 'stale failure' }); await Promise.all(tasks.splice(0));
  assert.equal(view.entries.get('').length, 500); assert.equal(view.limited.size > 0, true); assert.equal(view.errors.size, 0);
  view.refresh(project, cx); replies[2]({ code: 1, stderr: 'Permission denied' }); await Promise.all(tasks);
  assert.equal(view.errors.get(''), 'Permission denied');
});

test('automatic reload preserves expanded folders, selection and editor; deleted previews show an error', async () => {
  let text = 'before';
  const { view, cx, drain } = await scenario(async () => text);
  view.toggle('src', cx); view.cursor = 'main.ts'; view.show('main.ts', cx); await drain();
  const editor = view.code;
  view.reload(cx); await drain();
  assert.equal(view.code, editor); assert.equal(editor.changes, 0);
  text = 'after'; view.reload(cx); await drain();
  assert.equal(view.code, editor); assert.equal(editor.changes, 1);
  assert.equal(editor.value(), 'after'); assert.equal(editor.released, false);
  assert.equal(view.expanded.has('src'), true); assert.equal(view.cursor, 'main.ts');
  text = null; view.reload(cx); await drain();
  assert.equal(view.code, null); assert.equal(editor.released, true);
  assert.match(view.fileError, /no longer available/);
});

test('Markdown previews handle empty files and live updates, and release the code editor when switching', async () => {
  let text = 'const a = 1;';
  const { view, cx, editors, drain } = await scenario(async () => text);
  view.show('main.ts', cx); await drain();
  const code = view.code;
  text = '# Title\n\n- First\n- Second\n\n```js\nconst a = 1;\n```';
  view.show('README.MD', cx); await drain();
  assert.equal(code.released, true); assert.equal(view.code, null);
  assert.equal(view.markdown, text); assert.equal(editors.length, 1);
  view.expanded.add('src'); view.cursor = 'README.MD';
  text = '# Updated'; view.reload(cx); await drain();
  assert.equal(view.markdown, '# Updated'); assert.equal(view.expanded.has('src'), true);
  assert.equal(view.cursor, 'README.MD');
  text = ''; view.show('empty.markdown', cx); await drain();
  assert.equal(view.markdown, ''); assert.equal(view.code, null);
  text = 'plain text'; view.show('notes.txt', cx); await drain();
  assert.equal(view.markdown, null); assert.equal(view.code.value(), 'plain text');
  text = 'x'.repeat(400001); view.show('large.md', cx); await drain();
  assert.ok(view.markdown.endsWith('(preview truncated)'));
  text = null; view.reload(cx); await drain();
  assert.equal(view.markdown, null); assert.match(view.fileError, /no longer available/);
  text = 'a\0b'; view.show('binary.md', cx); await drain();
  assert.equal(view.markdown, null); assert.match(view.fileError, /Binary/);
});

test('late Markdown reads cannot overwrite another file or reopen a closed preview', async () => {
  const replies = [];
  const { view, cx, drain } = await scenario(() => new Promise(resolve => replies.push(resolve)));
  view.show('old.md', cx); view.show('new.ts', cx);
  replies[1]('new code'); replies[0]('# Old'); await drain();
  assert.equal(view.markdown, null); assert.equal(view.code.value(), 'new code');
  view.show('closed.md', cx); view.close(); replies[2]('# Closed'); await drain();
  assert.equal(view.markdown, null); assert.equal(view.code, null);
});

test('native watch coalesces events, ignores .git, and stops on project switch or close', async () => {
  const waits = [], tasks = [], loads = [];
  const { FileViewer } = await load({ watchFolder: path => new Promise((resolve, reject) => waits.push({ path, resolve, reject })),
    exec: async (_cmd, args) => { if (args[2] === 'herdr-zed-status') return { code: 0, stdout: '' }; loads.push(args.at(-1)); return { code: 0, stdout: 'f\0a.ts\0' }; } });
  const cx = { timer: timers(), notify() {}, focus_handle: () => ({}), spawn(fn) {
    const task = { promise: fn(cx), cancel() { this.cancelled = true; } }; tasks.push(task); return task;
  } };
  const tick = () => new Promise(resolve => setImmediate(resolve));
  const view = new FileViewer(); view.init(cx); view.refresh({ id: 'local', folder: '/local' }, cx); await tick();
  waits[0].resolve(['/local\\.git\\index']); await tick();
  assert.equal(cx.timer.scheduled.filter(timer => timer.kind === 'after').length, 0);
  waits[1].resolve(['/local/a.ts']); await tick();
  waits[2].resolve(['/local/new.ts']); await tick();
  const queued = cx.timer.scheduled.filter(timer => timer.kind === 'after');
  assert.equal(queued.length, 1); assert.equal(queued[0].ms, 300);
  queued[0].callback(cx); await tick();
  assert.deepEqual(loads, ['/local', '/local']);
  const oldWatcher = view.watcher, oldPoll = view.poll;
  view.refresh({ id: 'next', folder: '/next' }, cx); await tick();
  assert.equal(oldWatcher.cancelled, true); assert.equal(oldPoll.cancelled, true);
  waits[3].resolve(['/local/stale.ts']); await tick();
  assert.deepEqual(loads, ['/local', '/local', '/next']);
  const watcher = view.watcher, poll = view.poll;
  view.close(); waits[4].resolve(['/next/closed.ts']); await tick();
  assert.equal(watcher.cancelled, true); assert.equal(poll.cancelled, true);
  assert.equal(view.context, null);
  await Promise.all(tasks.map(task => task.promise));
});

test('remote projects poll automatically and watch failures fall back to polling', async () => {
  const { view, cx, drain } = await scenario();
  let reloads = 0;
  view.reload = () => reloads++;
  const poll = cx.timer.scheduled.find(timer => timer.kind === 'every');
  assert.equal(poll.ms, 10000); poll.callback(cx); assert.equal(reloads, 1);
  const { FileViewer } = await load({ watchFolder: async () => { throw Error('watch unavailable'); },
    exec: async () => ({ code: 0, stdout: '' }) });
  const tasks = [], localCx = { timer: timers(), notify() {}, focus_handle: () => ({}), spawn(fn) { tasks.push(fn(localCx)); } };
  const local = new FileViewer(); local.init(localCx); local.refresh({ folder: '/local' }, localCx);
  await Promise.all(tasks); assert.equal(local.watchFailed, true);
  local.reload = () => reloads++;
  localCx.timer.scheduled[0].callback(localCx); assert.equal(reloads, 2);
  view.close(); local.close(); await drain();
});

test('changes during an in-flight listing schedule a second read rather than leaving a stale tree', async () => {
  const replies = [], tasks = [];
  const { FileViewer } = await load({ exec: (_cmd, args) => args[2] === 'herdr-zed-status' ? Promise.resolve({ code: 0, stdout: '' }) : new Promise(resolve => replies.push(resolve)) });
  const cx = { timer: timers(), notify() {}, focus_handle: () => ({}), spawn(fn) { tasks.push(fn(cx)); } };
  const view = new FileViewer(); view.init(cx); view.refresh(project, cx);
  view.reload(cx); view.reload(cx);
  replies[0]({ code: 0, stdout: 'f\0old.ts\0' }); await Promise.all(tasks.splice(0));
  assert.equal(replies.length, 2);
  replies[1]({ code: 0, stdout: 'f\0new.ts\0' }); await Promise.all(tasks.splice(0));
  assert.deepEqual(view.rows().map(row => row.name), ['new.ts']);
});

test('git status colors files and folders relative to a project inside the repository', async () => {
  const { parseStatus } = await load();
  const status = parseStatus(['app/', ' M app/src/a.js', '?? app/src/new/b.js', 'A  app/docs/c.md', 'R  app/d.js', 'app/old.js', ' D app/src/gone.js', '?? other/x', ''].join('\0'));
  assert.deepEqual(Object.fromEntries(status), {
    'src/a.js': 'modified', src: 'modified', 'src/new/b.js': 'added', 'src/new': 'added',
    'docs/c.md': 'added', docs: 'added', 'd.js': 'modified', 'src/gone.js': 'deleted' });
});

test('git status reads the project machine and treats folders outside Git as unchanged', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'devkits status '));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const run = promisify(execFile);
  const { gitStatus } = await load({ exec: async (cmd, args, options) => {
    assert.equal(options.on, 'box');
    const { stdout, stderr } = await run(cmd, args); return { code: 0, stdout, stderr };
  } });
  const shellFolder = process.platform === 'win32' ? folder.replaceAll(String.fromCharCode(92), '/') : folder;
  assert.equal((await gitStatus(shellFolder, 'box')).size, 0);
  await run('git', ['init', '-q'], { cwd: folder });
  await mkdir(join(folder, 'src'));
  await writeFile(join(folder, 'src', '新.js'), 'x');
  assert.deepEqual(Object.fromEntries(await gitStatus(shellFolder, 'box')), { 'src/新.js': 'added', src: 'added' });
  await writeFile(join(folder, '.gitignore'), '*.d.ts\ncache/\n!keep.d.ts\n');
  await writeFile(join(folder, 'src', 'gpui-kit.d.ts'), 'ignored');
  await writeFile(join(folder, 'keep.d.ts'), 'visible');
  await mkdir(join(folder, 'cache'));
  await writeFile(join(folder, 'cache', 'output.js'), 'ignored descendant');
  const status = await gitStatus(shellFolder, 'box');
  assert.equal(status.get('src/gpui-kit.d.ts'), 'ignored');
  assert.equal(status.get('src'), 'added');
  assert.equal(status.get('cache'), 'ignored');
  assert.equal(status.get('keep.d.ts'), 'added');
  const nested = await gitStatus(`${shellFolder}/src`, 'box');
  assert.equal(nested.get('gpui-kit.d.ts'), 'ignored');
});

test('ignored folders dim descendants without marking their parents changed', async () => {
  const { FileViewer, parseStatus } = await load();
  const view = new FileViewer();
  view.init({ focus_handle: () => ({}) });
  view.status = parseStatus('\0!! src/generated/\0!! src/gpui-kit.d.ts\0');
  assert.equal(view.status.has('src'), false);
  view.entries.set('', [{ name: 'src', dir: true }]);
  view.entries.set('src', [{ name: 'generated', dir: true }, { name: 'gpui-kit.d.ts', dir: false }, { name: 'main.js', dir: false }]);
  view.entries.set('src/generated', [{ name: 'output.js', dir: false }]);
  view.expanded = new Set(['src', 'src/generated']);
  assert.deepEqual(view.rows().map(row => [row.path, row.ignored]), [
    ['src', false], ['src/generated', true], ['src/generated/output.js', true],
    ['src/gpui-kit.d.ts', true], ['src/main.js', false],
  ]);
});

test('file actions copy project-relative and native full paths, and remote Reveal stays disabled', async () => {
  const nodes = new Map(), copied = [], closed = [], overlays = [];
  const element = id => {
    const el = new Proxy({}, { get: (_target, key) => {
      if (key in _target) return _target[key];
      if (key === 'when') return (condition, fn) => condition ? fn(el) : el;
      if (key === 'on_click' || key === 'on_key_down') return fn => { el[key === 'on_click' ? 'click' : 'keydown'] = fn; return el; };
      return () => el;
    } });
    nodes.set(id, el); return el;
  };
  let target = { folder: 'C:\\dev\\my project', path: 'src/你好.ts', overlay: 'actions' };
  const { FileMenu, FileViewer, fullPath } = await load({ theme: () => ({}), props: () => target,
    window: () => ({ platform: 'windows' }), closeOverlay: id => closed.push(id), openOverlay: value => overlays.push(value),
    DropdownMenuContent: element, DropdownMenuItem: element, DropdownMenuSeparator: () => element('separator') });
  const cx = { focus_handle: () => ({ focus() {} }), stop_propagation() {}, notify() {}, write_to_clipboard: text => copied.push(text) };
  const menu = new FileMenu(); menu.init(cx); menu.render();
  nodes.get('file-menu-relative').click({}, cx);
  nodes.get('file-menu-full').click({}, cx);
  assert.deepEqual(copied, ['src/你好.ts', 'C:\\dev\\my project\\src\\你好.ts']);
  assert.deepEqual(closed, ['actions', 'actions']);
  assert.equal(fullPath('/', 'src/file'), '/src/file');
  assert.equal(fullPath('/project/', 'src/file'), '/project/src/file');
  assert.equal(fullPath('C:/', 'file'), 'C:\\file');
  assert.equal(fullPath('\\\\server\\share\\', 'folder/file'), '\\\\server\\share\\folder\\file');
  target = { folder: '/remote/project', machine: 'server', path: 'src/file', overlay: 'remote-actions' };
  menu.index = 0; menu.render();
  nodes.get('file-menu-reveal').click({}, cx);
  assert.equal(closed.length, 2);
  nodes.get('file-menu').keydown({ key: 'up' }, cx);
  assert.equal(menu.index, 1);
  nodes.get('file-menu').keydown({ key: 'enter' }, cx);
  assert.equal(copied.at(-1), '/remote/project/src/file');
  const view = new FileViewer(); view.init(cx); view.context = target;
  view.openMenu('src', { x: 120, y: 80 }, cx);
  assert.equal(view.cursor, 'src');
  assert.deepEqual(overlays[0].at, { x: 120, y: 80 });
  assert.deepEqual(overlays[0].props, { view: 'file-menu', folder: target.folder, machine: 'server', path: 'src' });
});

test('Reveal passes paths as arguments to the platform file manager and reports failures', async () => {
  const calls = [];
  let code = 0;
  const { revealPath } = await load({ exec: async (cmd, args) => { calls.push([cmd, args]); return { code, stderr: 'failed' }; } });
  await revealPath('C:/dev/my project', 'src/你好.ts', 'windows');
  await revealPath('/my project', 'src/a.ts', 'macos');
  await revealPath('/my project', 'src/a.ts', 'linux');
  assert.deepEqual(calls, [
    ['explorer.exe', ['/select,C:\\dev\\my project\\src\\你好.ts']],
    ['open', ['-R', '/my project/src/a.ts']], ['xdg-open', ['/my project/src']],
  ]);
  code = 1; await revealPath('C:/dev', 'file', 'windows');
  await assert.rejects(revealPath('/project', 'file', 'macos'), /failed/);
  code = 2; await assert.rejects(revealPath('C:/dev', 'file', 'windows'), /failed/);
});

test('dragging the line beside a preview resizes the list within bounds and saves the width when released or left', async () => {
  const source = await readFile(new URL('../components/side-panel.js', import.meta.url), 'utf8');
  const nodes = new Map(), owners = new WeakMap();
  const element = () => {
    const data = { calls: {}, children: [] };
    const el = new Proxy(data, { get: (_target, key) => (...args) => {
      if (key === 'id') nodes.set(args[0], data);
      if (key === 'child') data.children.push(owners.get(args[0]) || args[0]); else data.calls[key] = args;
      return el;
    } });
    owners.set(el, data);
    return el;
  };
  const { SidePanelLayout, SidePanelState } = new Function('div', 'h_flex', source.replace(/^import .*;\r?\n/gm, '')
    .replace(/^export /gm, '') + '\nreturn { SidePanelLayout, SidePanelState };')(element, element);
  let saved = 300;
  const state = new SidePanelState(() => saved, width => { saved = width; });
  const cx = { notify() {}, stop_propagation() {} };
  const render = () => { nodes.clear(); SidePanelLayout('files-split', state, 'preview', 'tree'); return nodes.get('files-split'); };
  let root = render();
  assert.deepEqual(root.children[1].calls.w, [300]);
  assert.ok('cursor_col_resize' in nodes.get('files-split-handle').calls);
  nodes.get('files-split-handle').calls.on_mouse_down[1]({ position: { x: 1000 } }, cx);
  root.calls.on_mouse_move[0]({ position: { x: 950 } }, cx);
  root = render();
  assert.deepEqual(root.children[1].calls.w, [350]);
  assert.equal(saved, 300);
  root.calls.on_mouse_move[0]({ position: { x: 0 } }, cx);
  root.calls.on_mouse_up[1]({}, cx);
  assert.equal(saved, 560);
  nodes.get('files-split-handle').calls.on_mouse_down[1]({ position: { x: 500 } }, cx);
  root.calls.on_mouse_move[0]({ position: { x: 2000 } }, cx);
  root.calls.on_hover[0](false, cx);
  assert.equal(saved, 200);
  root.calls.on_hover[0](false, cx);
  assert.equal(state.drag, null);
  nodes.get('files-split-handle').calls.on_click[0]({ click_count: 2 }, cx);
  assert.equal(saved, 280);
});


test('closing a tab follows recent activation and Ctrl+Tab keeps a stable recent order until release', async () => {
  const { view, cx, drain } = await scenario();
  for (const path of ['a.ts', 'b.ts', 'c.ts']) view.show(path, cx, true);
  await drain(); view.activate('a.ts', cx); view.activate('c.ts', cx);
  view.closeTab('c.ts', cx);
  assert.equal(view.file, 'a.ts');
  view.show('c.ts', cx, true); await drain();
  view.cycleTab(1, cx); assert.equal(view.file, 'a.ts');
  view.cycleTab(1, cx); assert.equal(view.file, 'b.ts');
  view.cycleTab(1, cx); assert.equal(view.file, 'c.ts');
  view.finishTabSwitch();
  view.cycleTab(-1, cx); assert.equal(view.file, 'b.ts');
});


test('absolute file tabs retain their source machine, normal Markdown preview and restore behavior', async () => {
  const reads = [];
  let text = '# Notes';
  const { view, cx, drain } = await scenario(async (path, options) => { reads.push([path, options]); return text; });
  const path = '/outside/notes.md';
  view.show('repo.md', cx, true); await drain();
  view.show(path, cx, true, { on: null }); await drain();
  assert.deepEqual(reads.at(-1), [path, { on: null }]);
  assert.equal(view.markdown, '# Notes');
  assert.equal(view.code, null);
  assert.equal(view.preview, null);
  view.show(path, cx, true, { on: null }); await drain();
  assert.deepEqual(view.tabs.map(doc => doc.path), ['repo.md', path]);
  view.refresh({ ...project, id: 'other', folder: '/other' }, cx); await drain();
  view.refresh(project, cx); await drain();
  assert.equal(view.file, path);
  assert.deepEqual(reads.at(-1), [path, { on: null }]);
  view.activate('repo.md', cx); await drain();
  assert.deepEqual(reads.at(-1), ['/project/repo.md', { on: 'server' }]);
  view.activate(path, cx);
  text = '# Updated'; view.reload(cx); await drain();
  assert.equal(view.markdown, '# Updated');
  view.closeTab(path, cx); assert.equal(view.file, 'repo.md');
});

test('absolute paths resolve without project prefixes on Unix and Windows', async () => {
  const { fullPath } = await load();
  assert.equal(fullPath('/repo', '/outside/notes.md'), '/outside/notes.md');
  assert.equal(fullPath('C:\\repo', 'D:\\outside\\notes.md'), 'D:\\outside\\notes.md');
  assert.equal(fullPath('/repo', 'src/notes.md'), '/repo/src/notes.md');
});
