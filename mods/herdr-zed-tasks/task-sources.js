import { shared, appHome, exec } from 'herdr';
import { folderKey } from './components/session-model.js';

// Source browsers are independently running mods (herdr-zed-asana, herdr-zed-mantisbt); Tasks only exchanges messages with them.
const SOURCE_MODS = { 'herdr-zed-asana': 'asana', 'herdr-zed-mantisbt': 'mantisbt' };
const SOURCES = Object.values(SOURCE_MODS);
const SOURCE_LABELS = { asana: 'Asana', mantisbt: 'MantisBT' };

// The source browsers the shell reports as enabled and loaded without error, for the board's "Import from" menu.
export function installedSources(catalog) {
  const packages = catalog?.packages || [], unavailable = new Set((catalog?.resolved?.unavailable || []).map(entry => entry.mod));
  return Object.entries(SOURCE_MODS)
    .filter(([mod]) => !unavailable.has(mod) && packages.some(entry => entry.mod === mod && entry.enabled && !entry.error))
    .map(([, key]) => ({ key, label: SOURCE_LABELS[key] }));
}

// The project whose context names this folder (or the given id). Null when no open project matches.
export function findProject(projects, context = {}) {
  if (context.id) { const byId = projects.find(project => project.id === context.id); if (byId) return byId; }
  if (!context.folder) return null;
  return projects.find(project => (project.machine || null) === (context.machine || null) && folderKey(project.folder) === folderKey(context.folder)) || null;
}

// Revalidates an import request (importer contract, §2.2.3) against live projects. Returns { project, snapshot } or { error }.
export function resolveTaskImport({ source, kind = 'task-snapshot', context, snapshot } = {}, projects = []) {
  if (kind !== 'task-snapshot') return { error: 'Unsupported import kind.' };
  if (!SOURCES.includes(source)) return { error: 'Unknown import source.' };
  if (!snapshot || typeof snapshot !== 'object' || snapshot.source !== source || typeof snapshot.gid !== 'string' || !snapshot.gid)
    return { error: 'This import is no longer valid. Import the task again.' };
  const project = findProject(projects, context);
  if (!project) return { error: 'This project is no longer open in herdr-zed.' };
  return { project, snapshot };
}

export class SourceTaskReader {
  init() {}
  show(task, cx) {
    if (this.selected === task.gid && (this.detail || this.detailRequest)) return;
    const request = { gid: task.gid, folder: this.folder }; this.detailRequest = request;
    this.selected = task.gid; this.detail = null; this.detailError = null;
    const source = task.source === 'mantisbt' ? 'mantisbt' : 'asana';
    const project = shared(`herdr-zed.${source}-projects`)?.[JSON.stringify(['', folderKey(this.folder)])]?.gid || '';
    cx.spawn(async cx => {
      try {
        const result = await exec('node', [`${appHome()}/mods/herdr-zed-${source}/read-task.js`, appHome(), String(task.gid), String(project), task.server || '']);
        const detail = JSON.parse(result.stdout || '{}');
        if (this.detailRequest !== request || this.folder !== request.folder) return;
        if (result.code !== 0 || detail.error) this.detailError = detail.error || 'Could not read this source task.';
        else this.detail = detail;
      } catch (error) { if (this.detailRequest === request) this.detailError = error.message; }
      finally { if (this.detailRequest === request) { this.detailRequest = null; cx.notify(); } }
    });
  }
}
