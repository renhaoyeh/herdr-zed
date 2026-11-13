// Herdr XD MCP, newline-delimited JSON-RPC over stdio. stdout is protocol-only.
const { createInterface } = require('node:readline');
const { join } = require('node:path');
const { homedir } = require('node:os');
const source = { type: 'string', description: 'Public Adobe XD share/prototype JSON URL, or absolute directory containing prototype.json, artboard.json, interactions.json, globalResources.json and cached images.' };
const artboard = { type: 'string', description: 'Artboard ID returned by inspect_xd. Required when the design contains several artboards.' };
const tool = (name, description, properties, required, readOnly) => ({ name, description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
  annotations: { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: readOnly } });
const tools = [
  tool('inspect_xd', 'Read an XD design. Without artboard, list available artboards; with artboard, summarize layers, text, components and known rendering limitations. No project files are changed.', { source, artboard }, ['source'], true),
  tool('get_node', 'Read the geometry, styles, text, states and children of an XD node. Use inspect_xd to find IDs. Coordinates are local to the parent.', { source, artboard, node: { type: 'string' }, depth: { type: 'integer', minimum: 0, maximum: 5, default: 1 } }, ['source', 'node'], true),
  tool('export_xd', 'Export an XD artboard to a self-contained HTML preview in this Herdr home. Returns paths and missing-resource warnings. Fixed geometry; no auto-animate interpolation. Never writes into the project.', { source, artboard }, ['source'], false),
  tool('verify_xd', 'Verify an export using headless Chrome/Edge without opening a visible window. Returns interaction checks, missing states, PNG preview and optional reference-image difference. pass means supported checks passed; complete additionally requires no reported missing data. Does not guarantee pixel fidelity.', { directory: { type: 'string', description: 'Exact directory returned by export_xd.' } }, ['directory'], false),
];
function start(input = process.stdin, output = process.stdout, dispatch) {
  const home = process.argv[2] || process.env.HERDR_APP_HOME || join(homedir(), '.config', 'herdr-app');
  const call = dispatch || (async (name, args) => (await import('./api.js')).xdCall(home, name, args));
  const send = value => output.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
  const lines = createInterface({ input, crlfDelay: Infinity });
  let initialized = false, pending = Promise.resolve();
  lines.on('line', line => { pending = pending.then(async () => {
    let request;
    try { if (line.length > 100000) throw Error(); request = JSON.parse(line); }
    catch { send({ id: null, error: { code: -32700, message: 'Invalid JSON or oversized message.' } }); return; }
    if (!request || Array.isArray(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
      send({ id: request?.id ?? null, error: { code: -32600, message: 'Invalid request' } }); return;
    }
    if (request.id === undefined) return;
    const reply = result => send({ id: request.id, result });
    if (request.method === 'initialize') {
      initialized = true;
      const supported = ['2024-11-05', '2025-03-26', '2025-06-18'];
      reply({ protocolVersion: supported.includes(request.params?.protocolVersion) ? request.params.protocolVersion : '2025-06-18',
        capabilities: { tools: {} }, serverInfo: { name: 'herdr-xd', version: '0.1.0' } }); return;
    }
    if (request.method === 'ping') { reply({}); return; }
    if (!initialized) { send({ id: request.id, error: { code: -32000, message: 'Initialize first' } }); return; }
    if (request.method === 'tools/list') { reply({ tools }); return; }
    if (request.method !== 'tools/call') { send({ id: request.id, error: { code: -32601, message: 'Method not found' } }); return; }
    if (!tools.some(t => t.name === request.params?.name)) { send({ id: request.id, error: { code: -32602, message: 'Unknown tool' } }); return; }
    try {
      const value = await call(request.params.name, request.params.arguments ?? {});
      reply({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
    } catch (error) {
      // URLs can contain public-share access tokens. Never echo them in MCP errors.
      const message = String(error.message).replace(/https?:\/\/\S+/g, '[Adobe URL]');
      reply({ isError: true, content: [{ type: 'text', text: message }] });
    }
  }).catch(() => process.stderr.write('XD MCP request failed.\n')); });
  return { lines, drained: () => pending };
}
module.exports = { start, tools };
if (require.main === module) start();
