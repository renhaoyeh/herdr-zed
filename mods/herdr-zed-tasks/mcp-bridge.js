import { appHome, readTextFile, writeTextFile, exec, watchFolder, checking } from 'herdr';
import { tasksMcpCall } from './mcp-api.js';

// Commands reach shown copies only; the background owner watches its inbox instead.
export class TasksMcpBridge {
  init(runtime, cx) {
    if (checking()) return;
    const directory = `${appHome()}/data/herdr-zed/tasks-mcp`;
    const seen = new Map();
    let pending = Promise.resolve(), scanning = false;
    const receive = async (path, cx) => {
      const name = path.replaceAll('\\', '/').split('/').at(-1);
      if (!/^[a-f0-9-]{36}\.request\.json$/.test(name)) return;
      const id = name.slice(0, -13);
      try {
        const request = JSON.parse(await readTextFile(`${directory}/${name}`));
        if (!request || request.id !== id || !Number.isFinite(request.until)
          || request.until < Date.now() || request.until > Date.now() + 30000 || seen.has(id)) return;
        let result;
        try { result = { ok: true, value: tasksMcpCall(runtime, request.name, request.args) }; }
        catch (error) { result = { ok: false, error: error.message }; }
        seen.set(id, result);
        if (seen.size > 256) seen.delete(seen.keys().next().value);
        await writeTextFile(`${directory}/${id}.json`, JSON.stringify(result), null);
        runtime.refresh(cx); cx.notify();
      } catch (error) { console.log(`Tasks MCP: ${error.message}`); }
    };
    const enqueue = (files, cx) => {
      pending = pending.then(async () => { for (const file of files) await receive(file, cx); });
      return pending;
    };
    const scan = async cx => {
      if (scanning) return;
      scanning = true;
      try {
        const result = await exec('node', [`${appHome()}/mods/herdr-zed-tasks/mcp-server.cjs`, '--pending', directory], { timeout: 5000 });
        if (result.code !== 0) throw Error(result.stderr || 'Could not read Tasks MCP inbox.');
        await enqueue(JSON.parse(result.stdout), cx);
      } catch (error) { console.log(`Tasks MCP: ${error.message}`); }
      finally { scanning = false; }
    };
    cx.spawn(async cx => {
      await scan(cx);
      try {
        let changes = watchFolder(directory);
        // Reconcile the startup gap after the directory exists and the watch is armed.
        await scan(cx);
        for (;;) {
          const files = await changes;
          // Arm the next batch before processing; requests can arrive while writes await I/O.
          changes = watchFolder(directory);
          if (files.some(path => path.replaceAll('\\', '/') === directory.replaceAll('\\', '/'))) await scan(cx);
          else await enqueue(files, cx);
        }
      } catch (error) { console.log(`Tasks MCP watch: ${error.message}`); }
    });
  }
}
