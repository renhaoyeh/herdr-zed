import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { openConfig } from '../mods/herdr-zed-agents/codex-config.js';

test('settings reads and writes use an npm-style Codex shim without a system shell on Windows', async t => {
  const directory = await mkdtemp(join(tmpdir(), "devkits config 中文 ' $(literal) "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const server = join(directory, 'server.cjs');
  await writeFile(join(directory, 'codex'), '#!/bin/sh\nexec "$DEVKITS_FIXTURE_NODE" "$DEVKITS_FIXTURE_SERVER" "$@"\n', { mode: 0o755 });
  await writeFile(server, `
    if (!process.argv.includes('--no-daemon')) throw new Error('Settings helper must stay in its owned process');
    if (process.env.CODEX_HOME !== require('node:fs').realpathSync(process.env.CODEX_HOME))
      throw new Error('Account directory must be canonical');
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      const m = JSON.parse(line); if (!m.id) return;
      const result = m.method === 'config/read' ? { layers: [{ name: { type: 'user',
        file: require('node:path').join(process.env.CODEX_HOME, 'config.toml') }, config: { model: 'fixture' }, version: 'fixture' }] } : {};
      console.log(JSON.stringify({ id: m.id, result }));
    });
  `);
  const saved = Object.fromEntries(['PATH', 'DEVKITS_FIXTURE_NODE', 'DEVKITS_FIXTURE_SERVER'].map(key => [key, process.env[key]]));
  t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  process.env.PATH = directory + delimiter + process.env.PATH;
  process.env.DEVKITS_FIXTURE_NODE = process.execPath;
  process.env.DEVKITS_FIXTURE_SERVER = server;
  const account = join(directory, 'account'), alias = join(directory, 'account-link');
  await mkdir(account);
  await symlink(account, alias, 'junction');
  const config = await openConfig(alias);
  try { assert.equal(config.config.model, 'fixture'); await config.write([]); }
  finally { await config.close(); }
});
