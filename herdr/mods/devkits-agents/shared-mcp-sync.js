// Finite launch-preparation helper; never connects to an MCP server.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { openConfig } from './codex-config.js';

export async function syncSharedMcp(directory, servers, configService = openConfig) {
  await mkdir(directory, { recursive: true });
  const service = await configService(directory);
  try {
    const current = service.config.mcp_servers || {};
    const previous = service.config.devkits_shared_mcp?.servers || {};
    const edits = [];
    for (const [name, server] of Object.entries(servers)) {
      if (!isDeepStrictEqual(current[name], server)) edits.push({ keyPath: `mcp_servers.${JSON.stringify(name)}`, value: server, mergeStrategy: 'replace' });
    }
    for (const [name, server] of Object.entries(previous)) {
      // An independently edited entry has become account-owned; retain it.
      if (!Object.hasOwn(servers, name) && isDeepStrictEqual(current[name], server)) {
        edits.push({ keyPath: `mcp_servers.${JSON.stringify(name)}`, value: null, mergeStrategy: 'replace' });
      }
    }
    if (!isDeepStrictEqual(previous, servers)) edits.push({ keyPath: 'devkits_shared_mcp', value: { servers }, mergeStrategy: 'replace' });
    if (!edits.length) return;
    const original = await readFile(join(directory, 'config.toml')).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (original !== null) await writeFile(join(directory, 'config.toml.before-mcp-sync.bak'), original, { flag: 'wx', mode: 0o600 })
      .catch(error => { if (error.code !== 'EEXIST') throw error; });
    // Ownership and transports commit together, guarded by Codex's config revision.
    await service.write(edits);
  } finally { await service.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await syncSharedMcp(process.argv[2], JSON.parse(process.argv[3])); }
  catch { console.error('Could not synchronize shared MCP settings. Check the account config.toml and retry.'); process.exitCode = 1; }
}
