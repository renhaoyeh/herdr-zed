// One-shot, read-only streaming reader. Only booleans and event IDs leave this process.
const fs = require('node:fs');

function consumeTaskEvent(state, event, kind = 'codex') {
  const pending = state.pending ||= {};
  const payload = event.payload || {};
  const message = event.type === 'event_msg' && (payload.type === 'user_message' || payload.item?.type === 'UserMessage');
  if (message) { state.hasInput = true; state.pending = {}; return; }
  if (kind !== 'codex') {
    const content = event.message?.content;
    if (event.type === 'user' && !event.isMeta && !event.isCompactSummary) {
      const items = typeof content === 'string' ? [{ type: 'text', text: content }] : content || [];
      if (items.some(item => ['text', 'image'].includes(item.type))) { state.hasInput = true; state.pending = {}; }
      else for (const item of items) if (item.type === 'tool_result') delete state.pending[item.tool_use_id];
    }
    if (event.type === 'assistant' && Array.isArray(content)) for (const item of content)
      if (item.type === 'tool_use' && item.name === 'AskUserQuestion') pending[item.id] = { async: false };
    return;
  }
  if (event.type !== 'response_item') return;
  if (['function_call', 'custom_tool_call'].includes(payload.type)
    && /(?:^|\.|__)request_user_input(?:_async)?$/.test(payload.name || '')) {
    pending[payload.call_id] = { async: payload.name.endsWith('_async') };
  }
  if (['function_call_output', 'custom_tool_call_output'].includes(payload.type) && pending[payload.call_id]) {
    let result;
    try { result = typeof payload.output === 'string' ? JSON.parse(payload.output) : payload.output; } catch {}
    if (!pending[payload.call_id].async || result?.error || result?.isError || result?.accepted === false) delete pending[payload.call_id];
  }
}

async function readTaskEvents(file, kind, cursor = {}) {
  const stat = await fs.promises.stat(file);
  const reset = !cursor.inode || cursor.inode !== stat.ino || cursor.offset > stat.size;
  const state = reset ? { offset: 0, hasInput: false, pending: {}, inode: stat.ino } : { ...cursor, pending: { ...(cursor.pending || {}) } };
  const end = stat.size;
  if (state.offset < end) {
    let buffered = Buffer.alloc(0);
    for await (const chunk of fs.createReadStream(file, { start: state.offset, end: end - 1 })) {
      buffered = Buffer.concat([buffered, chunk]);
      let next;
      while ((next = buffered.indexOf(10)) >= 0) {
        const line = buffered.subarray(0, next).toString('utf8');
        state.offset += next + 1;
        buffered = buffered.subarray(next + 1);
        try { consumeTaskEvent(state, JSON.parse(line), kind); } catch {}
      }
    }
    // Leave an incomplete final line for the next read, without losing its prefix.
  }
  return { hasInput: Boolean(state.hasInput), needsInput: Object.keys(state.pending).length > 0, cursor: state };
}
module.exports = { consumeTaskEvent, readTaskEvents };
if (require.main === module) {
  let cursor;
  try { cursor = JSON.parse(process.argv[4] || '{}'); } catch { cursor = {}; }
  readTaskEvents(process.argv[2], process.argv[3] || 'codex', cursor)
    .then(result => process.stdout.write(JSON.stringify(result)))
    .catch(() => { process.exitCode = 1; });
}
