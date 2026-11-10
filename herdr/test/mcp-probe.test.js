import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { verifyMcp, mcpSetupInfo } from '../mods/devkits-agents/mcp-probe.js';

const stdioSource = `const r=require('node:readline').createInterface({input:process.stdin});r.on('line',line=>{const m=JSON.parse(line);if(!m.id)return;let result;if(m.method==='initialize')result={protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:String(process.pid)}};else if(m.method==='tools/list')result={tools:[{name:'fixture'}]};else process.exit(19);console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));});`;

test('stdio verification performs initialization and tool discovery, then cleans up its owned child', async () => {
  const result = await verifyMcp({ command: process.execPath, args: ['-e', stdioSource] });
  assert.equal(result.toolsCount, 1); assert.ok(result.verifiedAt > 0);
  assert.throws(() => process.kill(Number(result.serverName), 0), /ESRCH/);
  await assert.rejects(verifyMcp({ command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] }, { timeout: 80 }), /timed out/);
  await assert.rejects(verifyMcp({ command: '/missing-devkits-test-command', args: [] }), /Could not start/);
});

test('HTTP verification supports JSON and SSE, includes negotiated session headers and never calls tools', async () => {
  for (const sse of [false, true]) {
    const methods = []; let deleted = false;
    const server = createServer(async (req, res) => {
      if (req.method === 'DELETE') { deleted = true; res.writeHead(200).end(); return; }
      let body = ''; for await (const chunk of req) body += chunk;
      const message = JSON.parse(body); methods.push(message.method);
      assert.match(req.headers.accept, /application\/json/); assert.match(req.headers.accept, /text\/event-stream/);
      if (message.method === 'notifications/initialized') { res.writeHead(202).end(); return; }
      if (message.method === 'tools/list') {
        assert.equal(req.headers['mcp-session-id'], 'test-session'); assert.equal(req.headers['mcp-protocol-version'], '2025-06-18');
      }
      const result = message.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'http-fixture' } } : { tools: [{ name: 'only-discover' }] };
      res.setHeader('Mcp-Session-Id', 'test-session'); res.setHeader('Content-Type', sse ? 'text/event-stream' : 'application/json');
      const value = JSON.stringify({ jsonrpc: '2.0', id: message.id, result });
      res.end(sse ? `event: message\r\ndata: ${value}\r\n\r\n` : value);
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    try {
      const result = await verifyMcp({ url: `http://127.0.0.1:${server.address().port}/mcp` });
      assert.equal(result.toolsCount, 1); assert.equal(deleted, true);
      assert.deepEqual(methods, ['initialize', 'notifications/initialized', 'tools/list']);
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }
});

test('setup rejects remote URLs and literal credentials and reports the current host platform honestly', async () => {
  await assert.rejects(verifyMcp({ url: 'https://example.com/mcp' }), /local/);
  await assert.rejects(verifyMcp({ command: 'anything', env: { TOKEN: 'secret' } }), /literal credentials/);
  const info = await mcpSetupInfo();
  assert.ok(['windows', 'macos', 'linux'].includes(info.platform));
  if (process.platform !== 'win32') { assert.equal(info.bridgePath, null); assert.equal(info.suggestedBridge, null); }
});


test('built-in tool discovery does not require a terminal reporting identity', async () => {
  const previous = process.env.HC_TERMINAL_ID; delete process.env.HC_TERMINAL_ID;
  try {
    const server = { command: process.execPath, args: ['-e', stdioSource], env_vars: ['HC_TERMINAL_ID'] };
    await assert.rejects(verifyMcp(server), /Environment variable is unavailable/);
    const result = await verifyMcp(server, { builtin: true }); assert.equal(result.toolsCount, 1);
  } finally { if (previous === undefined) delete process.env.HC_TERMINAL_ID; else process.env.HC_TERMINAL_ID = previous; }
});
