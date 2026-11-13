import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { xdCall } from '../mods/herdr-zed-xd/api.js';
import { checkedExport } from '../mods/herdr-zed-xd/export.js';
import { loadDesign, download, embeddedPrototype, validatePrototype } from '../mods/herdr-zed-xd/design.js';
import { registerXd } from '../mods/herdr-zed-xd/setup-mcp.js';

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'herdr-xd-test-')), source = join(home, 'snapshot');
  t.after(() => rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  await mkdir(source);
  const board = { id: 'board', name: 'Panel', bounds: { x: 0, y: 0, width: 100, height: 100 }, resources: [], components: [{ id: 'agc', rel: 'primary' }] };
  const prototype = { manifest: { name: 'Fixture', artboards: [board] }, linkTemplate: { href: 'https://cdn-sharing.adobecc.com/content/test', data: { access_token: 'not-exported' } } };
  const agc = { children: [{ id: 'board', type: 'artboard', artboard: { children: [{ id: 'text', type: 'text', name: 'Caption', text: { rawText: '</script><script>throw Error("injection")</script>' }, style: { font: { family: 'Arial', size: 12 } }, transform: { tx: 5, ty: 20 } }] } }], artboards: { board: board.bounds } };
  for (const [name, value] of Object.entries({ 'prototype.json': prototype, 'artboard.json': agc, 'interactions.json': {}, 'globalResources.json': {} })) await writeFile(join(source, name), JSON.stringify(value));
  return { home, source, prototype, agc };
}

test('XD inspect and node tools select exact boards, bound subtrees and reject invalid arguments', async t => {
  const { home, source, prototype } = await fixture(t);
  assert.equal((await xdCall(home, 'inspect_xd', { source })).artboards[0].id, 'board');
  const inspect = await xdCall(home, 'inspect_xd', { source, artboard: 'board' });
  assert.equal(inspect.counts.text, 1);
  const node = await xdCall(home, 'get_node', { source, artboard: 'board', node: 'text' });
  assert.equal(node.node.transform.tx, 5);
  assert.ok(node.node.text.includes('</script>'));
  await assert.rejects(xdCall(home, 'get_node', { source, node: 'text', depth: 9 }), /depth/);
  await assert.rejects(xdCall(home, 'get_node', { source, node: 'missing' }), /not found/);
  await assert.rejects(xdCall(home, 'inspect_xd', { source, extra: true }), /arguments/);
  prototype.manifest.artboards.push({ ...prototype.manifest.artboards[0], id: 'other', name: 'Other' });
  await writeFile(join(source, 'prototype.json'), JSON.stringify(prototype));
  await assert.rejects(xdCall(home, 'export_xd', { source }), /Choose one/);
  await assert.rejects(xdCall(home, 'export_xd', { source, artboard: 'other' }), /unavailable/);
});

test('XD exports are isolated and escape source text without exporting share tokens', async t => {
  const { home, source } = await fixture(t);
  const a = await xdCall(home, 'export_xd', { source }), b = await xdCall(home, 'export_xd', { source });
  assert.notEqual(a.directory, b.directory);
  assert.equal(await checkedExport(home, a.directory), a.directory);
  const html = await readFile(a.html, 'utf8');
  assert.ok(html.includes('Content-Security-Policy'));
  assert.ok(html.includes('\\u003c/script>'));
  assert.ok(!html.includes('not-exported'));
  assert.equal(a.warnings.length, 1, 'missing snapshot reference is explicit');
  await assert.rejects(xdCall(home, 'verify_xd', { directory: source }), /export_xd/);
});

test('XD shared registration preserves other servers, creates a backup and respects disabled connections', async t => {
  const { home } = await fixture(t);
  await mkdir(join(home, 'mods', 'herdr-zed-xd'), { recursive: true });
  await writeFile(join(home, 'mods', 'herdr-zed-xd', 'mcp-server.cjs'), '');
  await mkdir(join(home, 'data', 'herdr-zed'), { recursive: true });
  const file = join(home, 'data', 'herdr-zed', 'shared-mcp.json'), other = { command: 'existing', args: ['preserve'] };
  const before = JSON.stringify({ version: 1, servers: { other } });
  await writeFile(file, before);
  const result = await registerXd(home);
  assert.equal(await readFile(result.backup, 'utf8'), before);
  const config = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(config.servers.other, other);
  assert.equal((await registerXd(home)).changed, false);
  config.servers.herdr_xd.enabled = false; await writeFile(file, JSON.stringify(config));
  assert.equal((await registerXd(home)).enabled, false);
  config.servers.herdr_xd.command = 'personal'; await writeFile(file, JSON.stringify(config));
  await assert.rejects(registerXd(home), /different herdr_xd/);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).servers.herdr_xd.command, 'personal');
});

test('XD remote loader treats embedded JSON as data and restricts redirect destinations', async () => {
  const prototype = { manifest: { name: 'Remote', artboards: [{ id: 'one' }] }, linkTemplate: { href: 'https://cdn-sharing.adobecc.com/content/test', data: {} } };
  const html = `<script>window.bootstrap=${JSON.stringify({ nested: { prototype } })};</script>`;
  assert.deepEqual(embeddedPrototype(html), prototype);
  const design = await loadDesign('https://xd.adobe.com/view/example/', { fetcher: async () => new Response(html) });
  assert.equal(design.prototype.manifest.name, 'Remote');
  await assert.rejects(download('https://other.example/design'), /Adobe/);
  await assert.rejects(download('https://xd.adobe.com/view/example/', async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } })), /Adobe/);
  await assert.rejects(download('https://xd.adobe.com/view/example/', async () => new Response('x', { headers: { 'content-length': 40 * 1024 * 1024 } })), /32 MiB/);
});

test('XD CDN storage manifests normalize component revisions, board IDs and resource membership', () => {
  const raw = { 'manifest-format-version': 1, name: 'Storage', children: [
    { path: 'artwork', children: [{ path: 'artboard-board', name: 'Panel', 'uxdesign#bounds': { width: 100, height: 100 },
      components: [{ id: 'thumb', rel: 'thumbnail', version: '2' }], children: [{ components: [{ id: 'agc', rel: 'primary', version: '3' }] }] }] },
    { path: 'resources', components: [{ id: 'image', path: 'uid', version: '1', 'uxdesign#containingArtboards': ['board'] }] },
    { path: 'interactions', components: [{ id: 'events', version: '4' }] } ] };
  const p = validatePrototype(raw, 'https://cdn-sharing.adobecc.com/content/id?component_id=manifest&access_token=test');
  assert.equal(p.manifest.artboards[0].id, 'board');
  assert.equal(p.manifest.artboards[0].components[1].revision, '3');
  assert.deepEqual(p.manifest.artboards[0].resources, ['uid']);
  assert.equal(p.manifest.interactions.revision, '4');
  assert.equal(p.linkTemplate.data.access_token, 'test');
  assert.equal(p.linkTemplate.data.component_id, undefined);
});

test('XD headless verification renders a static export and treats zero interactions as valid', { skip: !process.env.XD_MCP_BROWSER_TEST }, async t => {
  const { home, source } = await fixture(t);
  const exported = await xdCall(home, 'export_xd', { source });
  const result = await xdCall(home, 'verify_xd', { directory: exported.directory });
  assert.equal(result.pass, true);
  assert.equal(result.complete, false, 'missing reference is reported');
  assert.equal(result.results.length, 0);
  assert.ok((await readFile(result.preview)).length > 100);
});

test('XD MCP stdio initialization, discovery, validation and export work in a real Node process', async t => {
  const { home, source } = await fixture(t);
  const server = fileURLToPath(new URL('../mods/herdr-zed-xd/mcp-server.cjs', import.meta.url));
  const child = spawn(process.execPath, [server, home], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  let stdout = '', stderr = '';
  child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
  const requests = [
    { id: 1, method: 'tools/list' },
    { id: 2, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } },
    { method: 'notifications/initialized' },
    { id: 3, method: 'tools/list' },
    { id: 4, method: 'tools/call', params: { name: 'inspect_xd', arguments: { source } } },
    { id: 5, method: 'tools/call', params: { name: 'export_xd', arguments: { source, artboard: 'board' } } },
    { id: 6, method: 'tools/call', params: { name: 'get_node', arguments: { source, node: 'text', depth: -1 } } },
  ];
  child.stdin.end(requests.map(r => JSON.stringify({ jsonrpc: '2.0', ...r })).join('\n') + '\n');
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, stderr);
  assert.equal(stderr, '');
  const replies = stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(replies.length, 6);
  assert.equal(replies[0].error.message, 'Initialize first');
  assert.equal(replies[1].result.protocolVersion, '2025-06-18');
  assert.deepEqual(replies[2].result.tools.map(t => t.name), ['inspect_xd', 'get_node', 'export_xd', 'verify_xd']);
  assert.equal(replies[3].result.structuredContent.artboards[0].id, 'board');
  assert.ok((await readFile(replies[4].result.structuredContent.html, 'utf8')).includes('window.xdInput'));
  assert.equal(replies[5].result.isError, true);
});
