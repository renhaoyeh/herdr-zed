// Explicit one-time migration, never part of session startup.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSharedMcp } from './components/shared-mcp-model.js';
import { openConfig } from './codex-config.js';

export async function migrateSharedMcp({ file, profiles, names }, configService = openConfig) {
  const connections = [];
  try {
    for (const profile of profiles) connections.push({ ...profile, service: await configService(profile.directory) });
    let original = null;
    try { original = await readFile(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const shared = parseSharedMcp(original);
    for (const name of names) {
      if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error('Unsupported MCP server name.');
      const candidates = connections.map(profile => profile.service.config.mcp_servers?.[name]).filter(Boolean);
      const server = shared.servers[name] || candidates[0];
      if (!server) continue;
      if (server.env || server.http_headers || server.bearer_token || (!server.command && !/^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(server.url || ''))) {
        throw new Error(`Cannot share ${name}: expected a local integration without literal credentials.`);
      }
      shared.servers[name] = server;
    }
    // Validate transport settings before changing any account. Keep the shared file first so a
    // partial migration leaves remaining account entries usable and can safely be run again.
    parseSharedMcp(JSON.stringify(shared));
    await mkdir(dirname(file), { recursive: true });
    if (original !== null) await writeFile(`${file}.before-migration.bak`, original, { flag: 'wx', mode: 0o600 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    await writeFile(file, `${JSON.stringify(shared, null, 2)}\n`, { mode: 0o600 });
    for (const profile of connections) {
      if (profile.keepConfig) continue; // Preserve standalone Codex outside Herdr.
      const edits = names.filter(name => shared.servers[name] && profile.service.config.mcp_servers?.[name])
        .map(name => ({ keyPath: `mcp_servers.${JSON.stringify(name)}`, value: null, mergeStrategy: 'replace' }));
      if (!edits.length) continue;
      const config = await readFile(join(profile.directory, 'config.toml'));
      await writeFile(join(profile.directory, 'config.toml.before-shared-mcp.bak'), config, { flag: 'wx', mode: 0o600 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      await profile.service.write(edits);
    }
    return { shared: Object.keys(shared.servers), migratedProfiles: connections.map(profile => profile.key) };
  } finally { await Promise.allSettled(connections.map(profile => profile.service.close())); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await migrateSharedMcp(JSON.parse(await readFile(process.argv[2], 'utf8'))))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
