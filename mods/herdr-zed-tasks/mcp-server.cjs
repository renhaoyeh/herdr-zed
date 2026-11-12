// Dependency-free MCP stdio endpoint (2025-06-18); all mutations go to the live owner.
const { createInterface } = require('node:readline');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { mkdir, readFile, writeFile, rm } = require('node:fs/promises');
const { join } = require('node:path');
const { homedir } = require('node:os');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const execute = promisify(execFile);
const home = process.env.HERDR_APP_HOME || join(homedir(), '.config', 'herdr-app');
const project = { type: 'string', description: 'Exact project key returned by list_projects.' };
const tools = [
  { name: 'list_projects', description: 'List projects available in the running Herdr Tasks service.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'list_tasks', description: 'List project tasks, including gid, status, parentId and archived state.', inputSchema: { type: 'object', properties: { project }, required: ['project'], additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'report_task', description: 'Report your Herdr task progress. Use doing to begin work or resume, waiting when a user answer is needed, done only when the whole task is complete, or fail when the attempt cannot finish. Include a concise progress/result message. Pass the exact run ID from the task prompt when supplied; otherwise omit run to bind to your own live HC terminal. Ending a reply is not task completion. Returns the current run ID.', inputSchema: { type: 'object', properties: { run: { type: 'string', minLength: 1, description: 'Exact task attempt ID from the task prompt. Omit for an ordinary conversation.' }, status: { type: 'string', enum: ['doing', 'waiting', 'done', 'fail'] }, message: { type: 'string', minLength: 1, maxLength: 4000 } }, required: ['status', 'message'], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false } },
  { name: 'delete_task', description: 'Delete a local task or a thread card from Herdr Tasks, as Delete on the board does. Only when the user asks; refused while its agent is active. Its conversation is kept.', inputSchema: { type: 'object', properties: { project, gid: { type: 'string', minLength: 1 } }, required: ['project', 'gid'], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true } },
  { name: 'create_task', description: 'Create a local Todo in Herdr Tasks without starting an agent. Use list_tasks to avoid duplicates, especially after a timeout. Optionally create a subtask using an existing nonarchived parent gid.', inputSchema: { type: 'object', properties: { project, name: { type: 'string', minLength: 1, maxLength: 1000 }, notes: { type: 'string', maxLength: 20000 }, priority: { type: 'string', enum: ['none', 'low', 'medium', 'high', 'urgent'] }, parentId: { type: 'string', minLength: 1 } }, required: ['project', 'name'], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false } },
];
async function bridge(name, args) {
  const id = randomUUID(), until = Date.now() + 10000;
  const directory = join(home, 'data', 'herdr-zed', 'tasks-mcp'), file = join(directory, `${id}.json`);
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(join(directory, `${id}.request.json`), JSON.stringify({ id, until, name, args }), { flag: 'wx' });
    await execute('herdr-app', ['do', `herdr-zed-tasks.mcp:${id}`], { timeout: 5000, windowsHide: true, env: { ...process.env, HERDR_APP_HOME: home } });
    while (Date.now() < until) {
      try {
        const result = JSON.parse(await readFile(file, 'utf8'));
        if (!result.ok) throw new Error(result.error);
        return result.value;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await delay(50);
    }
    throw new Error('Tasks service did not reply. Open the herdr-zed layout in Herdr. The operation may have succeeded; list_tasks before retrying.');
  } finally { await Promise.all([rm(file, { force: true }), rm(join(directory, `${id}.request.json`), { force: true })]); }
}
function start(input = process.stdin, output = process.stdout, call = bridge) {
  let initialized = false;
  const send = value => output.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
  const lines = createInterface({ input, crlfDelay: Infinity });
  // Serialize calls so a create followed by list observes the new task.
  let pending = Promise.resolve();
  lines.on('line', line => { pending = pending.then(async () => {
    let request;
    try { request = JSON.parse(line); } catch { send({ id: null, error: { code: -32700, message: 'Parse error' } }); return; }
    if (!request || Array.isArray(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string') { send({ id: request?.id ?? null, error: { code: -32600, message: 'Invalid request' } }); return; }
    if (request.id === undefined) return;
    const reply = result => send({ id: request.id, result });
    if (request.method === 'initialize') {
      initialized = true;
      reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'herdr-tasks', version: '1.0.0' } }); return;
    }
    if (request.method === 'ping') { reply({}); return; }
    if (!initialized) { send({ id: request.id, error: { code: -32000, message: 'Initialize first' } }); return; }
    if (request.method === 'tools/list') { reply({ tools }); return; }
    if (request.method !== 'tools/call') { send({ id: request.id, error: { code: -32601, message: 'Method not found' } }); return; }
    if (!tools.some(tool => tool.name === request.params?.name)) { send({ id: request.id, error: { code: -32602, message: 'Unknown tool' } }); return; }
    try {
      let args = request.params.arguments || {};
      if (request.params.name === 'report_task') {
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Arguments must be an object.');
        for (const key of Object.keys(args)) if (!['run', 'status', 'message'].includes(key)) throw new Error(`Unknown reporting field: ${key}`);
        if (args.run !== undefined && (typeof args.run !== 'string' || !args.run)) throw new Error('run must be a nonempty task attempt ID.');
        if (!args.run) {
          if (!process.env.HC_TERMINAL_ID) throw new Error('No HC terminal identity. Use the run ID supplied in your task prompt.');
          args = { ...args, terminal: process.env.HC_TERMINAL_ID };
        }
      }
      const value = await call(request.params.name, args); reply({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
    }
    catch (error) { reply({ isError: true, content: [{ type: 'text', text: error.message }] }); }
  }).catch(error => process.stderr.write(`${error.message}\n`)); });
  return { lines, drained: () => pending };
}
module.exports = { start, bridge, tools };
if (require.main === module) start();
