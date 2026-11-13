import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { PassThrough } from 'node:stream';
import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { projectMcpCall, readProjectState, projectPolicyPath, projectIdentity } from '../mods/herdr-zed-agents/ecc-project.js';
import { prepareProjectEcc } from '../mods/herdr-zed-agents/ecc-project-runtime.js';
import { evaluateNative } from './source-harness.js';
import { parseSharedMcp, platformSharedMcp, claudeMcpConfig, mcpToml } from '../components/shared-mcp-model.js';
import { sessionKind, tasksMcpServer } from '../components/session-model.js';
import { commandArgv } from '../components/session-shell.js';
import { parseEcc, eccAccount } from '../mods/herdr-zed-agents/ecc-model.js';

async function listNativeSkills(directory, folder, flags) {
  const [command, ...args] = commandArgv(['codex', '--no-daemon', ...flags, 'app-server', '--listen', 'stdio://'], process.platform === 'win32' ? 'windows' : process.platform);
  const child = spawn(command, args, { cwd: folder, env: { ...process.env, CODEX_HOME: directory }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Native skill discovery timed out')), 15000);
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('exit', () => { clearTimeout(timer); reject(Error('Native skill discovery exited')); });
      lines.on('line', line => {
        let message; try { message = JSON.parse(line); } catch { return; }
        if (message.id === 1) {
          child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
          child.stdin.write(`${JSON.stringify({ id: 2, method: 'skills/list', params: {} })}\n`);
        } else if (message.id === 2) { clearTimeout(timer); if (message.error) reject(Error(JSON.stringify(message.error))); else resolve(message.result); }
      });
      child.stdin.write(`${JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'herdr_project_test', version: '1.0' } } })}\n`);
    });
  } finally {
    lines.close(); child.stdin.end();
    if (child.exitCode === null) await new Promise(resolve => {
      const timer = setTimeout(() => { child.kill(); resolve(); }, 1500);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
}

async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'herdr-ecc-project-')), home = join(root, 'home'), folder = join(root, 'project'), other = join(root, 'other');
  const source = join(home, 'mods', 'herdr-zed-agents', 'ecc-source'), data = join(home, 'data', 'herdr-zed');
  for (const directory of [folder, other, data, join(source, '.claude-plugin'), join(source, '.codex-plugin'), join(source, 'skills', 'alpha'), join(source, 'rules', 'common')]) await mkdir(directory, { recursive: true });
  for (const host of ['claude', 'codex']) await writeFile(join(source, `.${host}-plugin`, 'plugin.json'), JSON.stringify({ name: 'ecc', version: '1.0.0', skills: './skills/' }));
  await writeFile(join(source, 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: Test alpha workflow\n---\n# Alpha\nRead project files.');
  await writeFile(join(source, 'rules', 'common', 'style.md'), '# Style\n\nKeep code simple.');
  await writeFile(join(source, '.mcp.json'), JSON.stringify({ mcpServers: { secret: { command: 'node', env: { TOKEN: 'private-literal' } }, missing: { command: 'node', args: ['/path/to/server.js'] } } }));
  await writeFile(join(data, 'shared-mcp.json'), JSON.stringify({ version: 1, servers: { browser: { command: 'browser', enabled: false } } }));
  const call = (name, args = {}) => projectMcpCall(home, name, { folder, provider: 'codex', ...args });
  try { await fn({ root, home, folder, other, source, data, call }); } finally { await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
}

test('ECC MCP reads catalog and effective defaults without modifying project, account or global settings', async () => fixture(async ({ call, folder, data }) => {
  const summary = await call('get_project');
  assert.equal(summary.scope, 'global'); assert.equal(summary.policy.enabled, false);
  assert.deepEqual(summary.mcp, [{ name: 'browser', enabled: false, supported: true }]);
  const catalog = await call('list_components', { group: 'skills', query: 'alpha', limit: 1 });
  assert.equal(catalog.total, 1); assert.equal(catalog.items[0].id, 'skills:alpha');
  assert.match((await call('read_component', { id: 'skills:alpha' })).text, /Read project files/);
  assert.ok(!JSON.stringify(await call('read_component', { id: 'mcp:secret' })).includes('private-literal'));
  await assert.rejects(access(join(data, 'ecc.json')), { code: 'ENOENT' });
  await assert.rejects(access(join(folder, '.codex')), { code: 'ENOENT' });
  await assert.rejects(call('get_project', { folder: 'relative' }), /absolute/);
  await assert.rejects(call('get_project', { extra: true }), /fields/);
  await assert.rejects(call('list_components', { limit: 101 }), /pagination/);
}));

test('any layout conversation can explain global ECC and browse components without a project or provider', async () => fixture(async ({ home, source, data }) => {
  const globalText = JSON.stringify({ version: 1, enabled: true, source, claudeHooks: 'off',
    providerEnabled: { claude: false, codex: true }, selection: { codex: { 'skills:alpha': false, 'rules:common/style.md': true } } });
  await writeFile(join(data, 'ecc.json'), globalText);
  const overview = await projectMcpCall(home, 'get_overview', {});
  assert.equal(overview.scope, 'global'); assert.equal(overview.ecc.name, 'Everything Claude Code');
  assert.equal(overview.ecc.providers.claude.enabled, false); assert.equal(overview.ecc.providers.codex.enabled, true);
  assert.ok(overview.ecc.providers.codex.selected.some(item => item.id === 'rules:common/style.md'));
  assert.ok(!overview.ecc.providers.codex.selected.some(item => item.id === 'skills:alpha'));
  assert.ok(overview.ecc.providers.claude.selected.some(item => item.id === 'skills:alpha'));
  assert.equal(overview.mcp.find(item => item.name === 'browser').enabled, false);
  assert.ok(!JSON.stringify(overview).includes('private-literal'));
  const skill = (await projectMcpCall(home, 'list_components', { group: 'skills' })).items[0];
  assert.equal(skill.id, 'skills:alpha');
  assert.equal(skill.selected.claude, true); assert.equal(skill.active.claude, false);
  assert.equal(skill.selected.codex, false); assert.equal(skill.active.codex, false);
  assert.match((await projectMcpCall(home, 'read_component', { id: 'skills:alpha' })).text, /Read project files/);
  assert.equal(await readFile(join(data, 'ecc.json'), 'utf8'), globalText);
  await assert.rejects(access(join(data, 'project-capabilities')), { code: 'ENOENT' });
  await assert.rejects(projectMcpCall(home, 'apply_project', { changes: {}, revision: 'guess' }), /Choose/);
}));

test('layout overview still explains MCP choices when the ECC source is unavailable', async () => fixture(async ({ home }) => {
  const overview = await projectMcpCall(home, 'get_overview', {}, { catalogReader: async () => { throw Error('ECC source is unavailable'); } });
  assert.equal(overview.ecc.catalogError, 'ECC source is unavailable');
  assert.equal(overview.mcp.find(item => item.name === 'browser').transport, 'stdio');
  assert.equal(overview.ecc.providers.codex.enabled, false);
}));

test('preview/apply/reset keep providers and projects independent and reject stale writes', async () => fixture(async ({ call, home, folder, other, data }) => {
  const changes = { enabled: true, replaceSelection: true, selection: { 'skills:alpha': true }, mcp: { browser: true } };
  const preview = await call('preview_project', { changes });
  assert.deepEqual(preview.selected, ['skills:alpha']);
  assert.equal((await call('get_project')).scope, 'global', 'preview never writes');
  const saved = await call('apply_project', { changes, revision: preview.revision });
  assert.equal(saved.scope, 'project'); assert.equal(saved.mcp[0].enabled, true);
  await assert.rejects(call('apply_project', { changes, revision: preview.revision }), /changed/);
  assert.equal((await call('get_project', { provider: 'claude' })).scope, 'global');
  assert.equal((await call('get_project', { folder: other })).scope, 'global');
  const claude = await call('preview_project', { provider: 'claude', changes: { enabled: false } });
  await call('apply_project', { provider: 'claude', changes: { enabled: false }, revision: claude.revision });
  const now = await call('get_project');
  await call('reset_project', { revision: now.revision });
  assert.equal((await call('get_project')).scope, 'global');
  assert.equal((await call('get_project', { provider: 'claude' })).scope, 'project');
  assert.equal(JSON.parse(await readFile(join(data, 'shared-mcp.json'), 'utf8')).servers.browser.enabled, false);
  await assert.rejects(access(join(data, 'ecc.json')), { code: 'ENOENT' });
  const identity = await projectIdentity(folder);
  assert.equal(JSON.parse(await readFile(projectPolicyPath(home, identity), 'utf8')).folder, identity);
}));

test('project plan rejects unavailable components, unknown connections, built-ins and global/source races', async () => fixture(async ({ call, data, source }) => {
  for (const changes of [{ selection: { 'skills:typo': true } }, { selection: { 'mcp:missing': true } }, { mcp: { unknown: true } }, { mcp: { herdr_tasks: false } }, { selection: { 'skills:alpha': 'yes' } }, { enabled: 'yes' }])
    await assert.rejects(call('preview_project', { changes }));
  const changes = { enabled: true, replaceSelection: true, selection: { 'skills:alpha': true } };
  const preview = await call('preview_project', { changes });
  await writeFile(join(source, 'skills', 'alpha', 'SKILL.md'), '# Changed\n\nNew behavior.');
  await assert.rejects(call('apply_project', { changes, revision: preview.revision }), /changed/);
  const next = await call('preview_project', { changes });
  await writeFile(join(data, 'shared-mcp.json'), '{"version":1,"servers":{}}');
  await assert.rejects(call('apply_project', { changes, revision: next.revision }), /changed/);
}));

test('project launch builds selected native resources and returns invocation-only plugin switches', async () => fixture(async ({ call, home, folder, root }) => {
  const account = join(root, 'account'); await mkdir(account);
  const id = 'ecc@herdr-zed-ecc-0123456789abcdef';
  const changes = { enabled: true, replaceSelection: true, selection: { 'skills:alpha': true, 'rules:common/style.md': true }, mcp: { browser: true } };
  const preview = await call('preview_project', { changes });
  await call('apply_project', { changes, revision: preview.revision });
  let closed = 0;
  const accountConfig = { plugins: { [id]: { enabled: true }, unrelated: { enabled: true } } };
  const configService = async () => ({ config: accountConfig, close: async () => closed++, write: async edits => {
    for (const edit of edits) accountConfig.plugins[JSON.parse(edit.keyPath.slice(8, -8))].enabled = edit.value;
  } });
  const codex = await prepareProjectEcc(home, folder, 'codex', account, { configService,
    run: async (provider, directory, args) => { accountConfig.plugins[args.at(-2)] = { enabled: true }; } });
  assert.equal(closed, 2); assert.ok(codex.flags.includes(`plugins.${id}.enabled=false`));
  assert.ok(codex.flags.some(arg => arg.startsWith('marketplaces.herdr-zed-project-ecc-')));
  assert.ok(codex.flags.some(arg => /plugins\.ecc@herdr-zed-project-ecc-.*\.enabled=true$/.test(arg)));
  assert.equal(accountConfig.plugins[id].enabled, true);
  assert.equal(Object.entries(accountConfig.plugins).find(([id]) => id.startsWith('ecc@herdr-zed-project-ecc-'))[1].enabled, false);
  assert.ok(!codex.flags.some(arg => arg.includes('unrelated')));
  assert.match(await readFile(codex.instructionsFile, 'utf8'), /Keep code simple/);
  assert.deepEqual(codex.mcp, { browser: true });
  const accountText = JSON.stringify({ enabledPlugins: { [id]: true, unrelated: true } });
  await writeFile(join(account, 'settings.json'), accountText);
  const cp = await call('preview_project', { provider: 'claude', changes });
  await call('apply_project', { provider: 'claude', changes, revision: cp.revision });
  const claude = await prepareProjectEcc(home, folder, 'claude', account);
  assert.ok(claude.flags.includes('--plugin-dir')); assert.ok(claude.flags.includes('--settings'));
  assert.equal(await readFile(join(account, 'settings.json'), 'utf8'), accountText);
  await assert.rejects(access(join(account, 'config.toml')), { code: 'ENOENT' });
}));

test('installed Codex discovers the project marketplace using invocation flags in an isolated account', async () => fixture(async ({ call, home, folder, root }) => {
  const directory = join(root, 'codex-account'); await mkdir(directory);
  const changes = { enabled: true, replaceSelection: true, selection: { 'skills:alpha': true } };
  const preview = await call('preview_project', { changes });
  await call('apply_project', { changes, revision: preview.revision });
  const result = await prepareProjectEcc(home, folder, 'codex', directory);
  const output = await promisify(execFile)('codex', ['--no-daemon', ...result.flags, 'plugin', 'list', '--available', '--json'], {
    cwd: folder, env: { ...process.env, CODEX_HOME: directory }, windowsHide: true, timeout: 15000,
  });
  const inventory = JSON.parse(output.stdout);
  assert.ok(JSON.stringify(inventory).includes('ecc@herdr-zed-project-ecc-'), JSON.stringify(inventory));
  const prompt = await promisify(execFile)('codex', ['--no-daemon', ...result.flags, 'debug', 'prompt-input', 'Inspect this project'], {
    cwd: folder, env: { ...process.env, CODEX_HOME: directory }, windowsHide: true, timeout: 15000,
  });
  assert.ok(prompt.stdout.includes('alpha'), 'Project skill must appear in the model-visible prompt');
  assert.match(await readFile(join(directory, 'config.toml'), 'utf8'), /enabled = false/);
  const withoutOverrides = await listNativeSkills(directory, folder, []);
  assert.ok(!withoutOverrides.data.some(row => row.skills.some(skill => skill.name === 'alpha' && skill.enabled)));
}));

test('failed native project installation restores disabled activation and preserves existing plugins', async () => fixture(async ({ call, home, folder, root }) => {
  const changes = { enabled: true, replaceSelection: true, selection: { 'skills:alpha': true } };
  const preview = await call('preview_project', { changes });
  await call('apply_project', { changes, revision: preview.revision });
  const directory = join(root, 'account'), accountConfig = { plugins: { personal: { enabled: true } } };
  const configService = async () => ({ config: accountConfig, close: async () => {}, write: async edits => {
    for (const edit of edits) accountConfig.plugins[JSON.parse(edit.keyPath.slice(8, -8))].enabled = edit.value;
  } });
  await assert.rejects(prepareProjectEcc(home, folder, 'codex', directory, { configService,
    run: async (provider, directory, args) => { accountConfig.plugins[args.at(-2)] = { enabled: true }; throw Error('Installer failed'); },
  }), /Installer failed/);
  assert.equal(accountConfig.plugins.personal.enabled, true);
  assert.equal(Object.entries(accountConfig.plugins).find(([id]) => id.startsWith('ecc@herdr-zed-project-ecc-'))[1].enabled, false);
  await assert.rejects(access(join(directory, 'herdr-zed-ecc.lock')), { code: 'ENOENT' });
}));

test('project writes respect a live project lock and remove their own lock after validation errors', async () => fixture(async ({ call, home, folder }) => {
  const state = await readProjectState(home, folder), path = projectPolicyPath(home, await projectIdentity(folder));
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(`${path}.lock`, String(process.pid));
  await assert.rejects(call('apply_project', { changes: { enabled: true }, revision: state.revision }), /being changed/);
  await rm(`${path}.lock`);
  await assert.rejects(call('apply_project', { changes: { selection: { bad: true } }, revision: state.revision }), /Unknown/);
  await assert.rejects(access(`${path}.lock`), { code: 'ENOENT' });
}));

test('shared project MCP switches affect argv while synchronized account defaults remain global', async () => {
  const writes = [], config = { version: 1, servers: { browser: { command: 'browser', enabled: false } } };
  const { sessionMcpArgv } = await evaluateNative('../components/shared-mcp.js', {
    appHome: () => '/herdr', home: () => '/home', window: () => ({ platform: 'windows' }), readTextFile: async () => JSON.stringify(config),
    exec: async (command, args) => { writes.push(JSON.parse(args[2])); return { code: 0 }; },
    parseSharedMcp, platformSharedMcp, claudeMcpConfig, mcpToml, sessionKind, tasksMcpServer,
  }, 'sessionMcpArgv');
  const argv = await sessionMcpArgv({ key: 'codex' }, ['codex'], { browser: true });
  assert.equal(writes[0].browser.enabled, false);
  assert.ok(argv.some(arg => arg.startsWith('mcp_servers.browser=') && arg.includes('"enabled"=true')));
  const claude = await sessionMcpArgv({ key: 'claude' }, ['claude'], { browser: true });
  const transports = JSON.parse(claude[claude.indexOf('--mcp-config') + 1]).mcpServers;
  assert.equal(transports.browser.command, 'browser');
  assert.equal(transports.herdr_ecc.args.at(-1), '/herdr');
});

test('native launch adapter applies project flags and bypasses global ECC synchronization', async () => {
  const calls = [], project = { flags: ['--plugin-dir', '/project-package'], mcp: { browser: false }, instructionsFile: '/project-guidance.md' };
  const { prepareEcc } = await evaluateNative('../mods/herdr-zed-agents/ecc.js', {
    appHome: () => '/herdr', home: () => '/user', parseEcc, eccAccount, sessionKind: () => 'claude',
    readTextFile: async () => assert.fail('Project override must bypass global ECC'),
    exec: async (command, args) => { calls.push(args); return { code: 0, stdout: JSON.stringify(project) }; },
  }, 'prepareEcc');
  const argv = ['env', 'CLAUDE_CONFIG_DIR=/account', 'claude', '--', 'literal prompt'];
  const result = await prepareEcc({}, argv, { folder: '/project' });
  assert.deepEqual(result.argv, ['env', 'CLAUDE_CONFIG_DIR=/account', 'claude', '--plugin-dir', '/project-package', '--', 'literal prompt']);
  assert.deepEqual(result.mcp, { browser: false }); assert.match(result.instructions, /project-guidance/);
  assert.deepEqual(calls[0], ['/herdr/mods/herdr-zed-agents/ecc-project-runtime.js', '/herdr', '/project', 'claude', '/account']);
});

test('ECC stdio MCP initializes, advertises schemas and returns application errors without terminating', async () => {
  const { start } = createRequire(import.meta.url)('../mods/herdr-zed-agents/ecc-mcp-server.cjs');
  const input = new PassThrough(), output = new PassThrough(); let text = '';
  output.on('data', chunk => { text += chunk; });
  const server = start(input, output, async (name, args) => { if (args.fail) throw Error('Rejected'); return { name }; });
  for (const request of [
    { id: 1, method: 'tools/list' }, { id: 2, method: 'initialize' }, { method: 'notifications/initialized' }, { id: 3, method: 'tools/list' },
    { id: 4, method: 'tools/call', params: { name: 'get_project', arguments: { fail: true } } },
    { id: 5, method: 'tools/call', params: { name: 'get_project', arguments: {} } },
  ]) input.write(`${JSON.stringify({ jsonrpc: '2.0', ...request })}\n`);
  await new Promise(resolve => setImmediate(resolve)); await server.drained(); input.end();
  const replies = text.trim().split('\n').map(JSON.parse);
  assert.equal(replies[0].error.code, -32000);
  const advertised = replies.find(item => item.id === 3).result.tools;
  assert.equal(advertised.length, 7);
  assert.deepEqual(advertised.find(item => item.name === 'get_overview').inputSchema.required, []);
  assert.deepEqual(advertised.find(item => item.name === 'list_components').inputSchema.required, []);
  assert.deepEqual(advertised.find(item => item.name === 'read_component').inputSchema.required, ['id']);
  assert.equal(replies.find(item => item.id === 4).result.isError, true);
  assert.equal(replies.find(item => item.id === 5).result.structuredContent.name, 'get_project');
});
