// Finite filesystem work for the explicit Herdr Zed data reset. Never edits shared.json.
import { execFile as execFileCallback } from 'node:child_process';
import { lstat, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { syncEcc } from './ecc-sync.js';
import { eccDefaults } from './ecc-model.js';
import { commandArgv } from './components/session-shell.js';

const execFile = promisify(execFileCallback);
const read = path => readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
const entries = path => readdir(path, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
async function plain(path) {
  const stat = await lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (stat?.isSymbolicLink()) throw new Error(`Remove the symbolic link before resetting: ${path}`);
}
async function roots(directory) {
  const root = resolve(directory), physical = await realpath(root);
  if (physical === dirname(physical)) throw new Error('Invalid Herdr home.');
  await plain(join(root, 'data'));
  await plain(join(root, 'data', 'herdr-zed'));
  return { root, data: join(root, 'data', 'herdr-zed') };
}
function object(source, name) {
  let value;
  try { value = source === null ? {} : JSON.parse(source); }
  catch { throw new Error(`Could not parse ${name}. Repair it before resetting.`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${name}.`);
  return value;
}

async function update(path, original, next) {
  await plain(path);
  if (await read(path) !== original) throw new Error('Settings changed during reset. Retry after closing other settings windows.');
  const temporary = `${path}.herdr-zed-reset-${process.pid}`;
  try {
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    if (await read(path) !== original) throw new Error('Settings changed during reset. Please retry.');
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

export async function inspectReset(directory) {
  const { root, data } = await roots(directory);
  await plain(join(root, 'programs.json'));
  const source = await read(join(root, 'programs.json'));
  const programs = object(source, 'programs.json');
  if (programs.programs !== undefined) object(JSON.stringify(programs.programs), 'program entries');
  const accountKeys = Object.entries(programs.programs || {}).filter(([key, entry]) => {
    if (!/^herdr-zed-(?:claude|codex)-[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/.test(key)) return false;
    if (!Array.isArray(entry?.run) || !entry.run.some(arg => String(arg).replaceAll('\\', '/').includes(data.replaceAll('\\', '/') + '/'))) {
      throw new Error(`Account ${key} uses a directory outside Herdr Zed. Remove it from Agent settings before resetting.`);
    }
    return true;
  }).map(([key]) => key);
  const accounts = [];
  for (const provider of ['claude', 'codex']) {
    await plain(join(data, provider));
    for (const entry of await entries(join(data, provider)))
      if (entry.isDirectory()) accounts.push({ provider, directory: join(data, provider, entry.name) });
  }
  return { accountKeys, accounts, programsSource: source, programs };
}

export async function signOut({ provider, directory }, execute = execFile, platform = process.platform === 'win32' ? 'windows' : process.platform) {
  const env = { ...process.env };
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) delete env[key];
  if (provider === 'codex') env.CODEX_HOME = directory;
  else { env.CLAUDE_CONFIG_DIR = directory; env.CLAUDE_SECURESTORAGE_CONFIG_DIR = directory; }
  try {
    const [command, ...args] = commandArgv([provider, ...(provider === 'codex' ? ['logout'] : ['auth', 'logout'])], platform);
    await execute(command, args, { env, timeout: 30000, windowsHide: true });
  } catch { throw new Error(`Could not sign out a Herdr Zed ${provider} account. Its files were kept; retry after checking the CLI.`); }
}

// Restore only integrations still owned by this installation. Default account credentials,
// conversations and independently changed settings stay outside the reset boundary.
export async function cleanDefaultClaude(root, userHome) {
  const directory = join(userHome, '.claude');
  await plain(directory);
  const path = join(directory, 'settings.json'), source = await read(path);
  const settings = object(source, 'Claude settings');
  const command = `node "${root.replaceAll('\\', '/')}/mods/herdr-zed-agents/usage/claude-statusline.js"`;
  if (settings.statusLine?.command === command) {
    const saved = await read(join(directory, 'herdr-zed-statusline-chain.json'));
    if (saved === null) delete settings.statusLine;
    else settings.statusLine = object(saved, 'previous Claude status line');
    await update(path, source, settings);
  }
  for (const name of ['herdr-zed-usage.json', 'herdr-zed-usage.json.tmp', 'herdr-zed-statusline-chain.json', 'settings.json.herdr-zed-backup'])
    await rm(join(directory, name), { force: true });
}

async function cleanDefaultCodex(root, userHome) {
  const directory = join(userHome, '.codex');
  await plain(directory);
  await plain(join(directory, 'config.toml'));
  const config = await read(join(directory, 'config.toml'));
  if (config?.includes('herdr_zed_shared_mcp')) {
    try { await execFile(process.execPath, [join(root, 'mods/herdr-zed-agents/shared-mcp-sync.js'), directory, '{}'], { timeout: 60000, windowsHide: true }); }
    catch { throw new Error('Could not remove Herdr Zed MCP settings from the default Codex account. Check Codex CLI and retry.'); }
  }
  await rm(join(directory, 'config.toml.before-herdr-zed-mcp-sync.bak'), { force: true });
}

// Native plugin managers keep ownership of their caches. Disable this product's
// ECC integration before removing the immutable packages it references.
export async function cleanDefaultEcc(userHome, sync = syncEcc) {
  for (const provider of ['claude', 'codex']) {
    const directory = join(userHome, `.${provider}`);
    await plain(directory);
    const marker = join(directory, 'herdr-zed-ecc.json');
    await plain(marker);
    if (await read(marker) === null) continue;
    await sync(provider, directory, eccDefaults);
    await rm(marker, { force: true });
  }
}

export async function resetProvider(directory, services = {}) {
  const { root } = await roots(directory);
  const plan = await inspectReset(root);
  for (const account of plan.accounts) await (services.signOut || signOut)(account);
  const userHome = services.userHome || homedir();
  await (services.cleanClaude || cleanDefaultClaude)(root, userHome);
  await (services.cleanCodex || cleanDefaultCodex)(root, userHome);
  await (services.cleanEcc || cleanDefaultEcc)(userHome);
  const latest = await inspectReset(root);
  if (latest.programsSource !== plan.programsSource || JSON.stringify(latest.accounts) !== JSON.stringify(plan.accounts))
    throw new Error('Accounts changed during reset. Account files were kept; retry.');
  for (const key of plan.accountKeys) delete plan.programs.programs[key];
  if (plan.accountKeys.length) await update(join(root, 'programs.json'), plan.programsSource, plan.programs);
}
if (process.argv[1] && await realpath(process.argv[1]).catch(() => null) === await realpath(fileURLToPath(import.meta.url))) {
  try {
    if (process.argv[2] === 'inspect') {
      const plan = await inspectReset(process.argv[3]);
      process.stdout.write(JSON.stringify({ accounts: plan.accounts.length }));
    } else if (process.argv[2] === 'clear' && process.argv[4] === 'HERDR ZED') {
      await resetProvider(process.argv[3]); process.stdout.write('{}');
    } else throw new Error('Invalid reset request.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
