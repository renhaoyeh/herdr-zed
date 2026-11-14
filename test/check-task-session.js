// Materialize the actual Tasks composer in a hidden native window with temporary state.
import { cp, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const root = await mkdtemp(join(tmpdir(), 'herdr-task-toolbar-')), mod = join(root, 'mod'), home = join(root, 'home');
try {
  await cp(fileURLToPath(new URL('../mods/herdr-zed-tasks/', import.meta.url)), mod, { recursive: true });
  await cp(fileURLToPath(new URL('../assets/icons/', import.meta.url)), join(home, 'mods/herdr-zed/assets/icons'), { recursive: true });
  for (const workflow of ['direct', 'supervisor']) {
    await writeFile(join(mod, 'main.js'), `
import { View } from 'gpui-kit';
import { setShared } from 'herdr';
import { TaskSession } from './task-session.js';
import { boardTheme } from './components/task-theme.js';
export default class extends View {
  init(_props, cx) {
    this.session = new TaskSession(); this.session.init(cx);
    this.session.allModels = () => [{ key: 'main', label: 'GPT-6.1-Sol', efforts: ['high'] }];
    setShared('herdr-zed.profile-sessions', { codex: { model: 'main', effort: 'high', workflow: ${JSON.stringify(workflow)}, eccProfile: 'inherit' } });
    setShared('herdr-zed.agents.workflow.executors', { supervisor: { owner: 'tasks', label: 'Supervisor', providers: ['codex', 'claude'], expiresAt: Date.now() + 15000 } });
  }
  render(cx) {
    return this.session.render({ gid: 'fixture', name: 'Test task' },
      [{ key: 'codex', name: 'Codex CLI · long-account-name@example.com', run: ['codex'] }],
      () => { throw Error('No real launch allowed in a render check.'); }, boardTheme(), cx)
      .w(576);
  }
}
`);
    const result = await promisify(execFile)('herdr-app', ['check', mod], { windowsHide: true, timeout: 60000,
      env: { ...process.env, HERDR_APP_HOME: home } });
    if (result.stderr.trim()) process.stderr.write(result.stderr);
    console.log(`Task toolbar ${workflow}: passed`);
  }
} finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
