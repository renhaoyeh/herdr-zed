// Read ECC as data. Never import or execute code from the selected source.
import { readFile, readdir, realpath, lstat } from 'node:fs/promises';
import { join, relative, resolve, extname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { eccGroups } from './ecc-model.js';

export const eccHash = value => createHash('sha256').update(value).digest('hex');
const slash = value => value.replaceAll('\\', '/');
async function optional(path) {
  try { return await readFile(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function files(root, subdirectory) {
  const directory = join(root, subdirectory), result = [];
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = slash(join(subdirectory, entry.name));
    if (entry.isDirectory()) result.push(...await files(root, path));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}
function frontmatter(text, key) {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] || '';
  const match = new RegExp(`^${key}:[ \\t]*([^\\r\\n]*)`, 'm').exec(block);
  if (!match) return '';
  let value = match[1].trim();
  if (/^[>|][-+]?$/u.test(value)) value = (block.slice(match.index + match[0].length).match(/^(?:\r?\n[ \t]+[^\r\n]*)*/)?.[0] || '').replace(/\s+/g, ' ').trim();
  if (/^["']/.test(value)) value = value.slice(1, -1);
  return value;
}
function summary(text) {
  return frontmatter(text, 'description') || text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
    .split(/\r?\n\s*\r?\n/).find(block => block.trim() && !/^\s*(?:#|```|\|)/.test(block))?.replace(/\s+/g, ' ').slice(0, 700) || '';
}
async function scriptSummary(root, script) {
  if (!script || !script.startsWith('scripts/hooks/')) return '';
  const text = await optional(join(root, script));
  return text?.match(/\/\*\*([\s\S]*?)\*\//)?.[1]?.replace(/^\s*\*\s?/gm, '').replace(/\s+/g, ' ').trim().slice(0, 700) || '';
}
function hookTarget(command = '') {
  const flags = /run-with-flags\.js\s+([^\s"']+)\s+([^\s"']+)/.exec(command);
  const scripts = [...command.matchAll(/scripts\/hooks\/([A-Za-z0-9_-]+\.js)/g)];
  return { checkId: flags?.[1], script: flags?.[2] || (scripts.length ? `scripts/hooks/${scripts.at(-1)[1]}` : '') };
}
function templateRequirements(value, path = '', result = new Set()) {
  if (typeof value === 'string') {
    for (const match of value.matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/g)) result.add(match[1]);
    if (/YOUR_|your[-_](?:api|key|token|project)|<[^>]+>|\/path\/to|REPLACE_/i.test(value)) result.add(path.startsWith('env.') ? path.slice(4) : `Template field: ${path}`);
  } else if (value && typeof value === 'object') for (const [key, entry] of Object.entries(value)) templateRequirements(entry, path ? `${path}.${key}` : key, result);
  return [...result];
}

export async function readEccCatalog(source) {
  const root = await realpath(resolve(source));
  const [claudeText, codexText] = await Promise.all(['.claude-plugin/plugin.json', '.codex-plugin/plugin.json'].map(path => readFile(join(root, path), 'utf8')));
  const claude = JSON.parse(claudeText), codex = JSON.parse(codexText);
  if (claude.name !== 'ecc' || codex.name !== 'ecc') throw new Error('Choose an ECC source folder with both Claude Code and Codex plugin manifests.');
  const items = [], fingerprint = [claudeText, codexText];
  const moduleText = await optional(join(root, 'manifests/install-modules.json'));
  const modules = moduleText ? JSON.parse(moduleText).modules || [] : [];
  for (const group of ['agents', 'skills', 'commands', 'rules', 'contexts', 'workflows']) {
    for (const path of await files(root, group)) {
      if (group === 'skills' ? basename(path) !== 'SKILL.md' : group === 'workflows' ? !path.endsWith('.workflow.js') : extname(path) !== '.md' || basename(path) === 'README.md') continue;
      const text = await readFile(join(root, path), 'utf8');
      fingerprint.push(path, text);
      const identity = group === 'skills' ? path.slice(0, -'/SKILL.md'.length) : path;
      const name = frontmatter(text, 'name') || basename(identity).replace(/\.(?:workflow\.js|md)$/, '');
      const tags = modules.filter(module => module.paths?.some(prefix => identity === prefix || identity.startsWith(`${prefix}/`))).map(module => module.id);
      const title = /^#\s+(.+)$/m.exec(text)?.[1]?.replace(/\r$/, '');
      items.push({ id: `${group}:${identity.slice(group.length + 1)}`, group, name, title, description: summary(text), path,
        providers: eccGroups.find(item => item.id === group).providers, defaultEnabled: !['rules', 'contexts'].includes(group),
        pack: group === 'rules' ? path.split('/')[1] : '', modules: tags, model: frontmatter(text, 'model'), tools: frontmatter(text, 'tools'),
        contentHash: eccHash(text), bytes: Buffer.byteLength(text) });
    }
  }
  for (const [provider, path] of [['claude', 'hooks/hooks.json'], ['codex', 'hooks/codex-hooks.json']]) {
    const text = await optional(join(root, path)); if (!text) continue;
    fingerprint.push(path, text);
    for (const [event, rows] of Object.entries(JSON.parse(text).hooks || {})) for (const row of rows) {
      const target = hookTarget(row.hooks?.[0]?.command);
      const name = (row.id || target.checkId || basename(target.script, '.js') || event)
        + (row.hooks?.some(hook => hook.async) ? ' · async' : /["']\s+sync$/.test(row.hooks?.[0]?.command || '') ? ' · sync' : '');
      const identity = { matcher: row.matcher || '', hooks: row.hooks?.map(hook => ({ ...hook, command: hook.command?.slice(hook.command.lastIndexOf('node scripts/hooks/')) })) };
      const id = `hooks:${provider}:${event}:${name}:${eccHash(JSON.stringify(identity)).slice(0, 10)}`;
      items.push({ id, group: 'hooks', name, description: row.description || await scriptSummary(root, target.script) || `${event} · ${row.matcher || 'All tools'} · ${target.script || 'Native event action'}`,
        path, event, matcher: row.matcher || '', providers: [provider], defaultEnabled: true, native: true, script: target.script,
        profiles: /run-with-flags\.js\s+\S+\s+\S+\s+([^\s"']+)/.exec(row.hooks?.[0]?.command || '')?.[1] || '', payload: row });
    }
  }
  // Dispatchers contain individually gated checks in addition to the native event rows.
  for (const path of ['scripts/hooks/bash-hook-dispatcher.js', 'scripts/hooks/posttooluse-dispatcher.js']) {
    const text = await optional(join(root, path)); if (!text) continue;
    fingerprint.push(path, text);
    const imports = new Map([...text.matchAll(/const\s*\{\s*run:\s*(\w+)\s*\}\s*=\s*require\(['"]\.\/([^'"]+)['"]\)/g)].map(match => [match[1], `scripts/hooks/${match[2]}.js`]));
    for (const match of text.matchAll(/\{\s*id:\s*['"]([^'"]+)['"]([\s\S]*?)\}/g)) {
      const checkId = match[1], body = match[2];
      const runName = /run:\s*(?:rawInput\s*=>\s*)?(\w+)/.exec(body)?.[1];
      const script = /script:\s*['"]([^'"]+)['"]/.exec(body)?.[1] || imports.get(runName) || path;
      const requires = items.filter(item => item.native && item.providers[0] === 'claude' && item.script === (checkId.startsWith('pre:bash:') ? 'scripts/hooks/pre-bash-dispatcher.js' : 'scripts/hooks/posttooluse-dispatcher.js')).map(item => item.id);
      items.push({ id: `hooks:check:${checkId}`, group: 'hooks', name: checkId, description: await scriptSummary(root, script) || `Individual tool-event check · ${script}`,
        path: script, providers: ['claude'], defaultEnabled: true, checkId, requires,
        profiles: /profiles:\s*['"]([^'"]+)['"]/.exec(body)?.[1] || 'standard,strict' });
    }
  }
  const templateText = await optional(join(root, 'mcp-configs/mcp-servers.json'));
  const rootMcpText = await optional(join(root, '.mcp.json'));
  const templates = templateText ? JSON.parse(templateText).mcpServers || {} : {};
  const bundled = rootMcpText ? JSON.parse(rootMcpText).mcpServers || {} : {};
  fingerprint.push(templateText || '', rootMcpText || '');
  for (const [name, server] of Object.entries({ ...templates, ...bundled })) {
    const requirements = templateRequirements(server);
    const blocked = requirements.filter(value => value.startsWith('Template field: '));
    items.push({ id: `mcp:${name}`, group: 'mcp', name, description: server.description || 'ECC MCP tool configuration', path: Object.hasOwn(bundled, name) ? '.mcp.json' : 'mcp-configs/mcp-servers.json',
      providers: ['claude', 'codex'], defaultEnabled: false, requirements, unavailable: blocked.length ? `This source template still needs configuration: ${blocked.join(', ')}` : '', payload: server });
  }
  // Include supporting runtime code in the revision without presenting libraries as independent features.
  for (const path of await files(root, 'scripts')) {
    if (!/\.(?:js|cjs|json)$/.test(path)) continue;
    const stat = await lstat(join(root, path));
    fingerprint.push(path, String(stat.size), String(stat.mtimeMs));
  }
  const ids = new Set();
  for (const item of items) { if (ids.has(item.id)) throw new Error(`ECC component identity is duplicated: ${item.id}`); ids.add(item.id); }
  return { source: root, version: claude.version, sourceRevision: eccHash(fingerprint.join('\0')), groups: eccGroups, items,
    modules: modules.map(({ id, description, dependencies }) => ({ id, description, dependencies: dependencies || [] })) };
}

export function eccCatalogForUi(catalog) {
  return { ...catalog, items: catalog.items.map(({ payload, ...item }) => item) };
}

export async function readEccDetail(catalog, id) {
  const item = catalog.items.find(item => item.id === id);
  if (!item) throw new Error('This ECC component no longer exists. Reload the source.');
  const path = resolve(catalog.source, item.path);
  if (slash(relative(catalog.source, path)).startsWith('../')) throw new Error('The ECC component is outside its source folder.');
  return item.payload ? JSON.stringify(item.payload, null, 2) : await readFile(path, 'utf8');
}
