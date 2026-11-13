// Hidden native render checks with a disposable mod/home; no project or agent is opened.
import { cp, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const root = await mkdtemp(join(tmpdir(), 'herdr-composer-render-')), mod = join(root, 'mod');
try {
  await cp(fileURLToPath(new URL('../mods/herdr-zed/', import.meta.url)), mod, { recursive: true });
  for (const state of ['loading', 'error', 'empty', 'results']) {
    await writeFile(join(mod, 'main.js'), `
import { View } from 'gpui-kit';
import { theme } from 'herdr';
import { startPanel } from './start-panel.js';
export default class extends View {
  init(_props, cx) {
    Object.assign(this, startPanel);
    this.refreshStartCommands = () => {};
    this.startGitView = () => null;
    this.initStartPanel(cx);
    this.startTarget = { intent: { launcher: 'fixture', choice: 'fixture' }, target: { folder: '/fixture' } };
    this.startTask.set_value('/');
    const state = ${JSON.stringify(state)};
    this.startCommandCache = { scope: this.startCommandScope(), items: state === 'loading' ? null : state === 'results'
      ? Array.from({ length: 8 }, (_, i) => ({ id: 'fixture:' + i, name: 'review-' + i, description: 'Review selected project files' })) : [], error: state === 'error' ? 'Could not read skills. Try again.' : null };
  }
  render(cx) {
    // Materialize the floating content eagerly too: check does not traverse Popup's deferred slot.
    return this.composerView({ name: 'Fixture' }, theme(), cx, { ready: true, takesTask: true }).child(this.startCommandMenu(theme()));
  }
}
`);
    const result = await promisify(execFile)('herdr-app', ['check', mod], { windowsHide: true, timeout: 20000,
      env: { ...process.env, HERDR_APP_HOME: join(root, 'home') } });
    if (result.stderr.trim()) process.stderr.write(result.stderr);
    console.log(`Composer ${state}: passed`);
  }
} finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
