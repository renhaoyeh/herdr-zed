import { nextCommand, appHome, readTextFile, writeTextFile } from 'herdr';
import { tasksMcpCall } from './mcp-api.js';

export class TasksMcpBridge {
  init(runtime, cx) {
    const seen = new Map();
    cx.spawn(async cx => {
      for (;;) {
        const command = await nextCommand();
        if (!command.startsWith('mcp:')) continue;
        try {
          const id = command.slice(4);
          if (!/^[a-f0-9-]{36}$/.test(id)) continue;
          const request = JSON.parse(await readTextFile(`${appHome()}/data/devkits/tasks-mcp/${id}.request.json`));
          if (!request || request.id !== id) continue;
          if (!/^[a-f0-9-]{36}$/.test(request.id) || !Number.isFinite(request.until) || request.until < Date.now() || request.until > Date.now() + 30000) continue;
          let result = seen.get(request.id);
          if (!result) {
            try { result = { ok: true, value: tasksMcpCall(runtime, request.name, request.args) }; }
            catch (error) { result = { ok: false, error: error.message }; }
            seen.set(request.id, result);
            if (seen.size > 256) seen.delete(seen.keys().next().value);
          }
          await writeTextFile(`${appHome()}/data/devkits/tasks-mcp/${request.id}.json`, JSON.stringify(result), null);
          runtime.refresh(cx); cx.notify();
        } catch (error) { console.log(`Tasks MCP: ${error.message}`); }
      }
    });
  }
}
