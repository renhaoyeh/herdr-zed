import { loadDesign, inspectBoard, getNode } from './design.js';
import { exportDesign } from './export.js';
import { verifyExport } from './verify.js';

export async function xdCall(home, name, args, dependencies = {}) {
  const fields = { inspect_xd: ['source', 'artboard'], get_node: ['source', 'artboard', 'node', 'depth'],
    export_xd: ['source', 'artboard'], verify_xd: ['directory'] };
  if (!fields[name]) throw Error('Unknown XD tool.');
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(k => !fields[name].includes(k))) throw Error('Invalid XD tool arguments.');
  for (const key of fields[name].filter(k => k !== 'depth')) {
    if (args[key] !== undefined && (typeof args[key] !== 'string' || !args[key].trim() || args[key].length > 20000)) throw Error(`${key} must be a nonempty string.`);
  }
  if (name === 'verify_xd') {
    if (!args.directory) throw Error('directory is required.');
    return verifyExport(home, args.directory);
  }
  const design = await loadDesign(args.source, dependencies);
  if (name === 'inspect_xd' && !args.artboard) return { name: design.prototype.manifest.name,
    artboards: design.prototype.manifest.artboards.map(a => ({ id: a.id, name: a.name, bounds: a.bounds, resources: a.resources?.length || 0 })) };
  const data = await design.artboard(args.artboard);
  if (name === 'inspect_xd') return { artboard: { id: data.board.id, name: data.board.name, bounds: data.bounds }, ...inspectBoard(data) };
  if (name === 'get_node') {
    if (!args.node) throw Error('node is required.');
    const depth = args.depth ?? 1;
    if (!Number.isInteger(depth) || depth < 0 || depth > 5) throw Error('depth must be an integer from 0 to 5.');
    return getNode(data, args.node, depth);
  }
  return exportDesign(home, design, data);
}
