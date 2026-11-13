// Standalone local MCP: reads ECC data and writes only revision-checked project policies.
const { createInterface } = require('node:readline');
const { join } = require('node:path');
const { homedir } = require('node:os');
const folder = { type: 'string', description: 'Absolute local project folder; use the current task project.' };
const provider = { type: 'string', enum: ['claude', 'codex'] };
const booleans = { type: 'object', additionalProperties: { type: 'boolean' } };
const changes = { type: 'object', properties: { enabled: { type: 'boolean' }, selection: booleans, mcp: booleans,
  sharedSkills: { ...booleans, description: 'Patch shared library Rules/Skills for this project/provider, using mine:rules:* or mine:skills:* IDs. Independent of the ECC master switch.' },
  replaceSelection: { type: 'boolean', description: 'Start with all ECC components off before applying selection; use for a minimal project setup.' },
  claudeHooks: { type: 'string', enum: ['off', 'minimal', 'standard', 'strict'] } }, additionalProperties: false };
const revision = { type: 'string', description: 'Exact revision returned by the latest preview/get_project. Conflicting edits are rejected.' };
const definition = (name, description, properties = {}, required = [], write = false) => ({ name, description,
  inputSchema: { type: 'object', properties: { ...(name === 'get_overview' ? {} : { folder, provider }), ...properties },
    required: [...(['get_overview', 'list_components', 'read_component'].includes(name) ? [] : ['folder', 'provider']), ...required], additionalProperties: false },
  annotations: { readOnlyHint: !write, destructiveHint: false, idempotentHint: true } });
const tools = [
  definition('get_overview', 'Explain this Herdr layout’s ECC (Everything Claude Code), skills and MCP configuration. Read saved global selections for both providers, component purposes and shared connection switches without a project folder. Start here when the user asks what ECC is, what they have enabled or which MCPs are configured. Read-only; does not report live connection health.'),
  definition('get_project', 'Read effective project ECC selections, shared library Skills/Rules and shared MCP switches, including unmet skill dependencies. No credentials or transports are returned.'),
  definition('list_components', 'Search ECC and the shared Skills/Rules library with provider support and setup requirements. Folder and provider are optional for general explanations. This does not enable anything.', {
    group: { type: 'string', enum: ['rules', 'skills', 'agents', 'commands', 'hooks', 'contexts', 'workflows', 'mcp'] }, query: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 } }),
  definition('read_component', 'Read an ECC or shared library component to explain its purpose or recommend it. Folder and provider are optional. MCP entries return requirements rather than transport credentials.', { id: { type: 'string' } }, ['id']),
  definition('preview_project', 'Preview a project change and return a revision. No settings are saved. Shared MCP names must already be configured.', { changes }, ['changes']),
  definition('apply_project', 'Save a reviewed project change when the user asks to apply it. Affects new local sessions only; never changes global or account settings. Use preview_project first. Do not apply recommendations without user authorization.', { changes, revision }, ['changes', 'revision'], true),
  definition('reset_project', 'Remove this provider’s project override and inherit global settings again, only when requested. Other providers and projects are preserved.', { revision }, ['revision'], true),
];
function start(input = process.stdin, output = process.stdout, call) {
  const home = process.argv[2] || process.env.HERDR_APP_HOME || join(homedir(), '.config', 'herdr-app');
  const dispatch = call || (async (name, args) => (await import('./ecc-project.js')).projectMcpCall(home, name, args));
  const send = value => output.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`);
  const lines = createInterface({ input, crlfDelay: Infinity });
  let initialized = false, pending = Promise.resolve();
  lines.on('line', line => { pending = pending.then(async () => {
    let request;
    try { request = JSON.parse(line); } catch { send({ id: null, error: { code: -32700, message: 'Parse error' } }); return; }
    if (!request || Array.isArray(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string') { send({ id: request?.id ?? null, error: { code: -32600, message: 'Invalid request' } }); return; }
    if (request.id === undefined) return;
    const reply = result => send({ id: request.id, result });
    if (request.method === 'initialize') { initialized = true; reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'herdr-ecc', version: '1.0.0' } }); return; }
    if (request.method === 'ping') { reply({}); return; }
    if (!initialized) { send({ id: request.id, error: { code: -32000, message: 'Initialize first' } }); return; }
    if (request.method === 'tools/list') { reply({ tools }); return; }
    if (request.method !== 'tools/call') { send({ id: request.id, error: { code: -32601, message: 'Method not found' } }); return; }
    if (!tools.some(tool => tool.name === request.params?.name)) { send({ id: request.id, error: { code: -32602, message: 'Unknown tool' } }); return; }
    try {
      const value = await dispatch(request.params.name, request.params.arguments ?? {});
      reply({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
    } catch (error) { reply({ isError: true, content: [{ type: 'text', text: error.message }] }); }
  }).catch(error => process.stderr.write(`${error.message}\n`)); });
  return { lines, drained: () => pending };
}
module.exports = { start, tools };
if (require.main === module) start();
