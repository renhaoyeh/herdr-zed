// Finite local helper. Native plugin managers own their caches and configuration.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commandArgv } from './components/session-shell.js';
import { openConfig } from './codex-config.js';
import { parseEcc } from './ecc-model.js';
import { buildEccPackage } from './ecc-package.js';
import { dirname } from 'node:path';

const executeFile = promisify(execFile);
async function runPlugin(provider, directory, args, input) {
  const env = { ...process.env, ...(provider === 'codex' ? { CODEX_HOME: directory }
    : { CLAUDE_CONFIG_DIR: directory, CLAUDE_SECURESTORAGE_CONFIG_DIR: directory }) };
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) delete env[key];
  const [command, ...argv] = commandArgv([provider, ...args], process.platform === 'win32' ? 'windows' : process.platform);
  const promise = executeFile(command, argv, { env, cwd: directory, windowsHide: true,
    detached: process.platform !== 'win32', maxBuffer: 4 * 1024 * 1024 });
  const timer = setTimeout(() => {
    if (!promise.child.pid) return;
    if (process.platform === 'win32') execFile('taskkill', ['/PID', String(promise.child.pid), '/T', '/F'], { windowsHide: true }, () => {});
    else { try { process.kill(-promise.child.pid, 'SIGKILL'); } catch {} }
  }, 45000);
  promise.child.stdin.on('error', () => {});
  if (input !== undefined) promise.child.stdin.end(input);
  else promise.child.stdin.end();
  try { return (await promise).stdout; }
  catch { throw new Error(`ECC: ${provider} ${args.slice(0, 3).join(' ')} failed. Check the native plugin settings and retry.`); }
  finally { clearTimeout(timer); }
}

async function readOptional(path) {
  try { return await readFile(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function syncEcc(provider, directory, rawConfig, { run = runPlugin, configService = openConfig,
  packageBuilder = buildEccPackage, packagesDirectory = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'devkits', 'ecc-packages') } = {}) {
  if (!['claude', 'codex'].includes(provider) || !directory) throw new Error('Unsupported ECC account.');
  const parsed = parseEcc(JSON.stringify(rawConfig)), markerPath = join(directory, 'devkits-ecc.json');
  const config = { ...parsed, enabled: parsed.enabled && parsed.providerEnabled[provider] };
  const previousText = await readOptional(markerPath);
  if (!config.enabled && previousText === null) return { instructionsFile: null };
  const previous = previousText === null ? null : JSON.parse(previousText);
  if (previous && (previous.version !== 1 || previous.provider !== provider || (previous.pluginId !== null && !/^ecc@devkits-ecc-[a-f0-9]{16}$/.test(previous.pluginId || ''))))
    throw new Error('ECC account setup record is invalid. Its plugins were left unchanged.');
  const bundle = config.enabled ? await packageBuilder(config, provider, packagesDirectory) : null;
  const desired = bundle?.native ? bundle.pluginId : null;
  const revision = config.enabled ? bundle.revision : 'disabled';
  const result = { instructionsFile: bundle?.instructions ? join(bundle.root, 'devkits-guidance.md') : null, pluginId: desired };
  await mkdir(directory, { recursive: true });
  const lock = join(directory, 'devkits-ecc.lock');
  try { await writeFile(lock, String(process.pid), { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = Number(await readOptional(lock));
    if (!Number.isSafeInteger(owner) || owner <= 0) throw new Error('ECC has an invalid setup lock. Check this account’s devkits-ecc.lock.');
    try { process.kill(owner, 0); throw new Error('ECC setup is already running for this account. Retry when it finishes.'); }
    catch (ownerError) {
      if (ownerError.code !== 'ESRCH') throw ownerError;
      await unlink(lock); await writeFile(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
    }
  }
  try {
    if (provider === 'claude') {
      const plugins = JSON.parse(await run(provider, directory, ['plugin', 'list', '--json']));
      if (!Array.isArray(plugins)) throw new Error('Claude returned an unsupported plugin inventory. Update Claude Code and retry.');
      if (desired && plugins.some(item => item.id === 'ecc@ecc' && item.enabled !== false))
        throw new Error('Claude already has ecc@ecc enabled. Disable that external installation before enabling the Devkits-controlled ECC package.');
      const installed = plugins.find(item => item.id === desired);
      if (installed && installed.scope !== 'user') throw new Error('The managed ECC plugin is not at global user scope.');
      if (desired && !installed) {
        await run(provider, directory, ['plugin', 'marketplace', 'add', bundle.root, '--scope', 'user', '--json']);
        await run(provider, directory, ['plugin', 'install', desired, '--scope', 'user', '--json']);
      }
      if (desired) {
        await run(provider, directory, ['plugin', 'configure', desired, '--values-stdin', '--json'], JSON.stringify({
          hooks_enabled: String(config.claudeHooks !== 'off'), hook_profile: config.claudeHooks === 'off' ? 'standard' : config.claudeHooks,
        }));
        if (installed?.enabled === false) await run(provider, directory, ['plugin', 'enable', desired, '--scope', 'user']);
      }
      for (const item of plugins.filter(item => /^ecc@devkits-ecc-[a-f0-9]{16}$/.test(item.id) && item.id !== desired && item.enabled !== false))
        await run(provider, directory, ['plugin', 'disable', item.id, '--scope', 'user']);
    } else {
      // Read first to reject duplicate externally enabled ECC without changing that account.
      let service = await configService(directory), installed = false;
      try {
        if (desired && service.config.plugins?.['ecc@ecc']?.enabled === true)
          throw new Error('Codex already has ecc@ecc enabled. Disable that external installation before enabling the Devkits-controlled ECC package.');
        installed = Boolean(desired && service.config.plugins?.[desired]);
      } finally { await service.close(); }
      if (desired && !installed) {
        await run(provider, directory, ['plugin', 'marketplace', 'add', bundle.root, '--json']);
        await run(provider, directory, ['plugin', 'add', desired, '--json']);
      }
      service = await configService(directory);
      try {
        const edits = [];
        if (desired && service.config.plugins?.[desired]?.enabled !== true)
          edits.push({ keyPath: `plugins.${JSON.stringify(desired)}.enabled`, value: true, mergeStrategy: 'replace' });
        for (const [id, item] of Object.entries(service.config.plugins || {})) if (/^ecc@devkits-ecc-[a-f0-9]{16}$/.test(id) && id !== desired && item.enabled !== false)
          edits.push({ keyPath: `plugins.${JSON.stringify(id)}.enabled`, value: false, mergeStrategy: 'replace' });
        if (edits.length) await service.write(edits);
      } finally { await service.close(); }
    }
    if (previous?.revision === revision && previous.pluginId === desired) return result;
    const temporary = `${markerPath}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 1, provider, revision, pluginId: desired }), { mode: 0o600 });
    await rename(temporary, markerPath);
    return result;
  } finally { await unlink(lock); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await syncEcc(process.argv[2], process.argv[3], parseEcc(await readFile(process.argv[4], 'utf8'))))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
