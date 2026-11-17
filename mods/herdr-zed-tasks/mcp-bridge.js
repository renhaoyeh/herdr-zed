import { appHome, readTextFile, writeTextFile, exec, watchFolder, checking } from 'herdr';
import { tasksMcpCall } from './mcp-api.js';

// Commands reach shown copies only; the background owner watches its inbox instead.
export class TasksMcpBridge {
  init(runtime, cx, initialize = () => {}) {
    if (checking()) return;
    const directory = `${appHome()}/data/herdr-zed/tasks-mcp`;
    const diagnosticPath = `${appHome()}/data/herdr-zed/tasks-mcp-diagnostics/service.json`;
    const events = [], startedAt = new Date().toISOString();
    const diagnostic = async (event, fields = {}) => {
      events.push({ at: new Date().toISOString(), event, ...fields });
      if (events.length > 100) events.shift();
      try { await writeTextFile(diagnosticPath, JSON.stringify({ startedAt, directory, events }), await readTextFile(diagnosticPath)); }
      catch (error) { console.log(`Tasks MCP diagnostic write failed: ${error.message}`); }
    };
    const failure = error => ({ error: String(error.message || error).slice(0, 2000), stack: String(error.stack || '').slice(0, 4000) });
    const seen = new Map();
    let pending = Promise.resolve(), scanning = false;
    const receive = async (path, cx) => {
      const name = path.replaceAll('\\', '/').split('/').at(-1);
      if (!/^[a-f0-9-]{36}\.request\.json$/.test(name)) return;
      const id = name.slice(0, -13);
      try {
        const request = JSON.parse(await readTextFile(`${directory}/${name}`));
        if (!request || request.id !== id || !Number.isFinite(request.until)
          || request.until < Date.now() || request.until > Date.now() + 30000 || seen.has(id)) {
          await diagnostic('request.ignored', { id, reason: seen.has(id) ? 'duplicate' : 'invalid-or-expired' }); return;
        }
        await diagnostic('request.received', { id, name: request.name });
        let result;
        try {
          result = { ok: true, value: tasksMcpCall(runtime, request.name, request.args) };
          await diagnostic('request.handled', { id, name: request.name });
        }
        catch (error) { result = { ok: false, error: error.message }; await diagnostic('request.rejected', { id, ...failure(error) }); }
        seen.set(id, result);
        if (seen.size > 256) seen.delete(seen.keys().next().value);
        await diagnostic('response.write.start', { id });
        await writeTextFile(`${directory}/${id}.json`, JSON.stringify(result), null);
        await diagnostic('response.write.complete', { id });
        await diagnostic('response.written', { id, ok: result.ok });
        // Projection refresh is owned by the runtime timer. Do not rebuild every
        // project's board on the serialized transport path after each reply.
        cx.notify();
      } catch (error) { await diagnostic('request.error', { id, ...failure(error) }); console.log(`Tasks MCP: ${error.message}`); }
    };
    const enqueue = (files, cx) => {
      pending = pending.then(async () => { for (const file of files) await receive(file, cx); });
      return pending;
    };
    const scan = async cx => {
      if (scanning) return;
      scanning = true;
      try {
        await diagnostic('scan.start');
        const result = await exec('node', [`${appHome()}/mods/herdr-zed-tasks/mcp-server.cjs`, '--pending', directory], { timeout: 5000 });
        if (result.code !== 0) throw Error(result.stderr || 'Could not read Tasks MCP inbox.');
        const files = JSON.parse(result.stdout);
        await diagnostic('scan.complete', { count: files.length });
        await enqueue(files, cx);
      } catch (error) { await diagnostic('scan.error', failure(error)); console.log(`Tasks MCP: ${error.message}`); }
      finally { scanning = false; }
    };
    cx.spawn(async cx => {
      await diagnostic('service.start');
      try { await initialize(cx, diagnostic); }
      catch (error) { await diagnostic('service.init.error', failure(error)); console.log(`Tasks MCP init: ${error.message}`); return; }
      await scan(cx);
      try {
        let changes = watchFolder(directory);
        await diagnostic('watch.armed');
        // Reconcile the startup gap after the directory exists and the watch is armed.
        await scan(cx);
        for (;;) {
          const files = await changes;
          // Arm the next batch before processing; requests can arrive while writes await I/O.
          changes = watchFolder(directory);
          await diagnostic('watch.batch', { count: files.length, root: files.some(path => path.replaceAll('\\', '/') === directory.replaceAll('\\', '/')) });
          if (files.some(path => path.replaceAll('\\', '/') === directory.replaceAll('\\', '/'))) await scan(cx);
          else await enqueue(files, cx);
        }
      } catch (error) { await diagnostic('watch.stopped', failure(error)); console.log(`Tasks MCP watch: ${error.message}`); }
    });
  }
}
