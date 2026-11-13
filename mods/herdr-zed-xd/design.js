import { readFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';

export const children = node => node.children || node.group?.children || node.artboard?.children || [];
export const ux = node => node.meta?.ux || {};
export const limitations = ['Fixed coordinates; responsive constraints are not implemented.',
  'State transitions switch immediately; auto-animate interpolation is not implemented.',
  'Alpha/image masks, compound winding and asymmetric corner radii are not implemented.',
  'Fonts use locally installed browser fonts; rendering may differ from Adobe.'];
const json = text => JSON.parse(text.replace(/^\uFEFF/, ''));
const MAX_BYTES = 32 * 1024 * 1024;

function adobeUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port
    || !['xd.adobe.com', 'cdn-sharing.adobecc.com'].includes(url.hostname))
    throw Error('Use an HTTPS Adobe XD share or cdn-sharing.adobecc.com manifest URL.');
  return url;
}

export async function download(value, fetcher = fetch) {
  let url = adobeUrl(value);
  for (let redirects = 0; redirects < 5; redirects++) {
    let response;
    try { response = await fetcher(url.href, { redirect: 'manual', signal: AbortSignal.timeout(20000) }); }
    catch { throw Error('Adobe request failed or timed out.'); }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      url = adobeUrl(new URL(response.headers.get('location'), url).href); continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw Error(`Adobe returned HTTP ${response.status}. The share may be private or expired.`); }
    if (Number(response.headers.get('content-length')) > MAX_BYTES) { await response.body?.cancel(); throw Error('Adobe response exceeds 32 MiB.'); }
    let size = 0; const chunks = [];
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > MAX_BYTES) throw Error('Adobe response exceeds 32 MiB.');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  throw Error('Too many Adobe redirects.');
}

export function componentUrl(prototype, component) {
  if (!component?.id) throw Error('XD component is missing.');
  const base = prototype.linkTemplate.href.split('{')[0];
  const url = adobeUrl(`${base};revision=${encodeURIComponent(component.revision ?? '0')}`);
  for (const [key, value] of Object.entries(prototype.linkTemplate.data || {})) url.searchParams.set(key, String(value));
  url.searchParams.set('component_id', component.id);
  return url.href;
}

export function validatePrototype(value, source) {
  if (value?.manifest?.artboards && value.linkTemplate?.href) return value;
  // Adobe's CDN exposes the DCX storage tree; the sharing bootstrap exposes an already flattened manifest.
  if (value?.['manifest-format-version'] && Array.isArray(value.children)) {
    const component = c => ({ ...c, revision: c.revision ?? c.version ?? '0' });
    const branch = path => value.children.find(n => n.path === path);
    const resources = branch('resources')?.components || [];
    const manifest = { name: value.name, id: value.id,
      interactions: branch('interactions')?.components?.[0] && component(branch('interactions').components[0]),
      globalResources: branch('globalResources')?.components?.[0] && component(branch('globalResources').components[0]),
      resources: Object.fromEntries(resources.map(c => [c.path, component(c)])),
      artboards: (branch('artwork')?.children || []).filter(n => n.path?.startsWith('artboard-')).map(n => {
        const id = n.path.slice('artboard-'.length);
        return { id, name: n.name, bounds: n['uxdesign#bounds'],
          components: [...(n.components || []), ...(n.children || []).flatMap(child => child.components || [])].map(component),
          resources: resources.filter(c => c['uxdesign#containingArtboards']?.includes(id)).map(c => c.path) };
      }) };
    return validatePrototype(manifest, source);
  }
  if (Array.isArray(value?.artboards)) {
    const url = adobeUrl(source), data = Object.fromEntries(url.searchParams);
    delete data.component_id; delete data.component_path;
    url.search = ''; url.pathname = url.pathname.replace(/;revision=[^/;]+$/, '');
    return { manifest: value, linkTemplate: { href: url.href, data } };
  }
  throw Error('The source is not an XD prototype manifest.');
}

// Parse embedded JSON as data, never execute the Adobe page's JavaScript.
export function embeddedPrototype(html) {
  function find(value, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 10) return null;
    if (value.manifest?.artboards && value.linkTemplate?.href) return value;
    for (const child of Object.values(value)) { const found = find(child, depth + 1); if (found) return found; }
    return null;
  }
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    const script = match[1].trim();
    try { const found = find(json(script)); if (found) return found; } catch {}
    // JSON object assignments used by the public sharing bootstrap.
    for (const start of script.matchAll(/(?:=|\()\s*(\{)/g)) {
      const offset = start.index + start[0].lastIndexOf('{');
      let depth = 0, quoted = false, escaped = false;
      for (let i = offset; i < script.length; i++) {
        const c = script[i];
        if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; }
        else if (c === '"') quoted = true;
        else if (c === '{') depth++;
        else if (c === '}' && --depth === 0) {
          try { const found = find(json(script.slice(offset, i + 1))); if (found) return found; } catch {}
          break;
        }
      }
    }
  }
  return null;
}

export async function loadDesign(source, { fetcher = fetch } = {}) {
  if (typeof source !== 'string' || !source.trim()) throw Error('source must be an Adobe URL or an absolute snapshot directory.');
  let directory = null, prototype;
  if (isAbsolute(source)) {
    directory = source;
    prototype = json(await readFile(join(directory, 'prototype.json'), 'utf8'));
    if (!Array.isArray(prototype?.manifest?.artboards)) throw Error('Snapshot prototype.json has no artboards.');
  } else {
    const url = adobeUrl(source), bytes = await download(url.href, fetcher), text = bytes.toString('utf8');
    try { prototype = validatePrototype(json(text), source); }
    catch {
      prototype = embeddedPrototype(text);
      if (!prototype) throw Error('This sharing page does not expose an embedded XD manifest. Use its prototype/manifest JSON URL or a downloaded snapshot directory.');
    }
  }
  const read = async (name, component) => {
    if (directory) return json(await readFile(join(directory, name), 'utf8'));
    if (!component) return {};
    return json((await download(componentUrl(prototype, component), fetcher)).toString('utf8'));
  };
  return { directory, prototype,
    async artboard(selector) {
      const boards = prototype.manifest.artboards;
      const matches = selector ? boards.filter(a => a.id === selector || a.name === selector) : boards.length === 1 ? boards : [];
      if (matches.length !== 1) throw Error('Choose one artboard ID returned by inspect_xd.');
      const board = matches[0];
      const agc = await read('artboard.json', board.components?.find(c => c.rel === 'primary'));
      const node = agc.children?.find(n => n.id === board.id);
      const bounds = agc.artboards?.[board.id];
      if (!node || !bounds || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)
        || bounds.width <= 0 || bounds.height <= 0 || bounds.width > 16384 || bounds.height > 16384 || bounds.width * bounds.height > 16777216)
        throw Error('Artboard geometry is missing, invalid, or unavailable in this snapshot.');
      // Render exactly the selected board, independent of input ordering.
      return { board, agc: { ...agc, children: [node] }, node, bounds,
        interactions: await read('interactions.json', prototype.manifest.interactions),
        globals: await read('globalResources.json', prototype.manifest.globalResources) };
    },
    async image(component, key) {
      if (directory) return readFile(join(directory, `${key}.png`));
      return download(componentUrl(prototype, component), fetcher);
    } };
}

export function walk(node, visit, depth = 0) {
  if (depth > 150) throw Error('XD tree exceeds the supported nesting depth.');
  visit(node);
  for (const child of children(node)) walk(child, visit, depth + 1);
  for (const state of ux(node).states || []) walk(state, visit, depth + 1);
}

export function inspectBoard(data) {
  const counts = {}, components = [], text = [], unsupported = new Set();
  walk(data.node, node => {
    counts[node.type] = (counts[node.type] || 0) + 1;
    if (node.text && text.length < 100) text.push({ id: node.id, text: node.text.rawText });
    if (ux(node).states?.length) components.push({ id: node.id, name: node.name, states: ux(node).states.length + 1 });
    if (node.shape && !['rect', 'circle', 'line', 'polygon', 'path'].includes(node.shape.type)) unsupported.add(node.shape.type);
  });
  return { counts, components, text, unsupported: [...unsupported], limitations };
}

export function getNode(data, id, depth = 1) {
  let selected;
  walk(data.node, node => { if (node.id === id && !selected) selected = node; });
  if (!selected) throw Error('Node ID was not found in this artboard.');
  let remaining = 500;
  function project(node, level) {
    if (--remaining < 0) throw Error('Node result exceeds 500 nodes; request a smaller subtree.');
    const u = ux(node);
    return { id: node.id, name: node.name, type: node.type, visible: node.visible !== false,
      transform: node.transform, style: node.style, shape: node.shape, text: node.text?.rawText,
      width: u.width, height: u.height, rangedStyles: u.rangedStyles, mask: u.isMaskGroup ? u.clipPathResources : undefined,
      constraints: Object.fromEntries(Object.entries(u).filter(([k]) => k.startsWith('constraint'))),
      state: u.stateId || u.symbolId, states: (u.states || []).map(s => ({ id: ux(s).stateId || ux(s).symbolId, name: s.name })),
      interactions: u.interactions, childCount: children(node).length,
      children: level > 0 ? children(node).map(c => project(c, level - 1)) : undefined };
  }
  return { node: project(selected, depth), coordinateSpace: 'Local to the parent; compose ancestor transform matrices for artboard coordinates.', limitations };
}
