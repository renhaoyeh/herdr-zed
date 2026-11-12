import { isMain } from './node-main.js';
// Finite launch-preparation helper; never connects to an MCP server.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { openConfig } from './codex-config.js';

export async function syncSharedMcp(directory, servers, configService = openConfig) {
  await mkdir(directory, { recursive: true });
  const service = await configService(directory);
  try {
    const current = service.config.mcp_servers || {};
    const marker = service.config.herdr_zed_shared_mcp;
    const previous = marker?.servers || {};
    const displaced = marker?.displaced || {};
    const saved = {};
    const edits = [];
    for (const [name, server] of Object.entries(servers)) {
      // Keep the account's original transport (including another product's), so
      // removing Zed restores it instead of deleting somebody else's connection.
      if (Object.hasOwn(previous, name) && isDeepStrictEqual(current[name], previous[name])) {
        if (Object.hasOwn(displaced, name)) saved[name] = displaced[name];
      } else if (Object.hasOwn(current, name)) saved[name] = current[name];
      if (!isDeepStrictEqual(current[name], server)) edits.push({ keyPath: `mcp_servers.${JSON.stringify(name)}`, value: server, mergeStrategy: 'replace' });
    }
    for (const [name, server] of Object.entries(previous)) {
      // An independently edited entry has become account-owned; retain it.
      if (!Object.hasOwn(servers, name) && isDeepStrictEqual(current[name], server)) {
        edits.push({ keyPath: `mcp_servers.${JSON.stringify(name)}`, value: displaced[name] ?? null, mergeStrategy: 'replace' });
      }
    }
    const next = Object.keys(servers).length ? { servers, displaced: saved } : null;
    if (!isDeepStrictEqual(marker ?? null, next)) edits.push({ keyPath: 'herdr_zed_shared_mcp', value: next, mergeStrategy: 'replace' });
    if (!edits.length) return;
    const original = await readFile(join(directory, 'config.toml')).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (original !== null) await writeFile(join(directory, 'config.toml.before-herdr-zed-mcp-sync.bak'), original, { flag: 'wx', mode: 0o600 })
      .catch(error => { if (error.code !== 'EEXIST') throw error; });
    // Ownership and transports commit together, guarded by Codex's config revision.
    await service.write(edits);
  } finally { await service.close(); }
}

if (await isMain(import.meta.url)) {
  try { await syncSharedMcp(process.argv[2], JSON.parse(process.argv[3])); }
  catch { console.error('Could not synchronize shared MCP settings. Check the account config.toml and retry.'); process.exitCode = 1; }
}
