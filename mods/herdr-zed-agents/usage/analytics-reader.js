// Local transcripts only. No credentials, provider requests, or Orca data dependencies.
import { readdir, stat, readFile, mkdir, writeFile, rename, realpath } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, resolve, dirname, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const amount = n => Number.isFinite(n) && n > 0 ? n : 0;
import { localDay } from './analytics-model.js';
export { summarize } from './analytics-model.js';

export async function parseTranscript(path, provider) {
  let session = '', project = 'Unknown project', model = 'Unknown model', previous = null;
  const events = new Map();
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    let o; try { o = JSON.parse(line); } catch { continue; }
    const p = o.payload || {};
    if (o.type === 'session_meta') { session = p.id || session; project = p.cwd || project; }
    if (o.type === 'turn_context') { model = p.model || model; project = p.cwd || project; }
    let usage, key;
    if (provider === 'codex' && p.type === 'token_count' && p.info?.total_token_usage) {
      const total = p.info.total_token_usage;
      // Repeated snapshots carry no new tokens. A reset starts a new counter segment.
      const reset = previous && amount(total.total_tokens) < amount(previous.total_tokens);
      const delta = name => Math.max(0, amount(total[name]) - (reset ? 0 : amount(previous?.[name])));
      usage = { input: delta('input_tokens'), output: delta('output_tokens'), cacheRead: delta('cached_input_tokens'),
        cacheWrite: delta('cache_write_input_tokens'), reasoning: delta('reasoning_output_tokens') };
      previous = total;
      usage.input = Math.max(0, usage.input - usage.cacheRead);
      key = `${o.timestamp}:${project}:${model}:${JSON.stringify(total)}`;
    } else if (provider === 'claude' && o.type === 'assistant' && o.message?.usage) {
      const u = o.message.usage;
      if (o.message.model === '<synthetic>') continue;
      session = o.sessionId || session; project = o.cwd || project; model = o.message.model || model;
      usage = { input: amount(u.input_tokens), output: amount(u.output_tokens), cacheRead: amount(u.cache_read_input_tokens),
        cacheWrite: amount(u.cache_creation_input_tokens), reasoning: amount(u.output_tokens_details?.thinking_tokens) };
      usage.cacheWrite1h = amount(u.cache_creation?.ephemeral_1h_input_tokens);
      // A streamed message can appear repeatedly with revised usage; retain its latest values.
      key = o.message.id || o.uuid || `${session}:${o.timestamp}`;
    } else continue;
    usage.total = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
    const timestamp = Date.parse(o.timestamp);
    if (!Number.isFinite(timestamp) || !usage.total) continue;
    events.set(key, { key: `${provider}:${key}`, session: `${provider}:${session || path}`, provider, project, model,
      timestamp, day: localDay(new Date(timestamp)), ...usage });
  }
  return [...events.values()];
}

async function filesUnder(directory, errors) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code !== 'ENOENT') errors.push(`Cannot read ${directory}`); return []; }
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path, errors));
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path);
  }
  return files;
}

export async function discoverSources(appHome, accounts = [], userHome = homedir()) {
  const sources = [{ provider: 'codex', directory: join(userHome, '.codex'), account: 'Codex' },
    { provider: 'claude', directory: join(userHome, '.claude'), account: 'Claude' }];
  for (const provider of ['codex', 'claude']) {
    const root = join(appHome, 'data', 'devkits', provider);
    for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory()) sources.push({ provider, directory: join(root, entry.name), account: entry.name });
    }
  }
  for (const account of accounts) {
    const env = account.provider === 'codex' ? 'CODEX_HOME=' : 'CLAUDE_CONFIG_DIR=';
    const directory = account.run?.find(arg => arg.startsWith(env))?.slice(env.length);
    if (directory) sources.push({ provider: account.provider, directory, account: account.name });
  }
  const unique = new Map();
  for (const source of sources) unique.set(`${source.provider}:${resolve(source.directory)}`, source);
  return [...unique.values()];
}

export async function scan(sources, cachePath) {
  let saved;
  try { saved = JSON.parse(await readFile(cachePath, 'utf8')); } catch {}
  const prior = saved?.version === 2 && saved.timezone === Intl.DateTimeFormat().resolvedOptions().timeZone ? saved.files : {};
  const files = {}, unique = new Map(), errors = [];
  for (const source of sources) {
    for (const folder of source.provider === 'codex' ? ['sessions', 'archived_sessions'] : ['projects']) {
      for (const path of await filesUnder(join(source.directory, folder), errors)) {
        try {
          const info = await stat(path), signature = `${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
          const events = prior?.[path]?.signature === signature ? prior[path].events : await parseTranscript(path, source.provider);
          files[path] = { signature, events };
          for (const event of events) unique.set(event.key, { ...event, account: source.account });
        } catch { errors.push(`Cannot read ${path}`); }
      }
    }
  }
  if (cachePath) {
    try {
      await mkdir(resolve(cachePath, '..'), { recursive: true });
      const temporary = `${cachePath}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify({ version: 2, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, files }));
      await rename(temporary, cachePath);
    } catch { errors.push('Could not save the statistics cache.'); }
  }
  // A transcript may move through several subfolders of the same project.
  const projects = new Map();
  await Promise.all([...new Set([...unique.values()].map(event => event.project))].map(async project => {
    let root = project;
    if (isAbsolute(project) && await stat(project).then(info => info.isDirectory(), () => false)) {
      let folder = resolve(project);
      while (true) {
        if (await stat(join(folder, '.git')).then(() => true, () => false)) { root = await realpath(folder).catch(() => folder); break; }
        const parent = dirname(folder); if (parent === folder) break; folder = parent;
      }
    }
    projects.set(project, root);
  }));
  return { events: [...unique.values()].map(event => ({ ...event, project: projects.get(event.project) })),
    errors, updatedAt: Date.now(), fileCount: Object.keys(files).length };
}

// Send only daily session/model aggregates to GPUI, never transcript events or content.
export function compactEvents(events) {
  const groups = new Map();
  for (const event of events) {
    const key = JSON.stringify([event.provider, event.day, event.session, event.project, event.model, event.account]);
    let row = groups.get(key);
    if (!row) {
      row = { provider: event.provider, day: event.day, session: event.session, project: event.project, model: event.model, account: event.account,
        timestamp: event.timestamp, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0, total: 0 };
      groups.set(key, row);
    }
    row.timestamp = Math.max(row.timestamp, event.timestamp);
    for (const field of ['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite1h', 'reasoning', 'total']) row[field] += event[field] || 0;
  }
  return [...groups.values()];
}


if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [appHome, accounts = '[]'] = process.argv.slice(2);
  const result = await scan(await discoverSources(appHome, JSON.parse(accounts)), join(appHome, 'data', 'devkits', 'analytics-cache.json'));
  console.log(JSON.stringify({ ...result, events: compactEvents(result.events) }));
}
