import { shared, setShared, openOverlay, notify, appHome, exec } from 'herdr';
import { folderKey } from './components/session-model.js';
import { createSourceChannel, sourceChannels, consumeSourceEvents, closeSourceChannel } from './components/source-channel.js';

// Source browsers are independently running mods (herdr-zed-asana, herdr-zed-mantisbt); Tasks only exchanges messages with them.
const SOURCES = ['asana', 'mantisbt'];

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

export class TaskSources {
  constructor(onImport = () => {}) { this.onImport = onImport; }
  init(cx) { cx.timer.every(200, cx => this.poll(cx)); }
  open(project, source = 'asana') {
    if (!project || !SOURCES.includes(source)) return;
    const context = { id: project.id, folder: project.folder, name: project.name, machine: project.machine || null };
    const key = JSON.stringify(['', folderKey(project.folder)]);
    const binding = shared(`herdr-zed.${source}-projects`)?.[key] || null;
    const channel = createSourceChannel({ receiver: 'herdr-zed-tasks', source, context, binding });
    return openOverlay({ mod: `herdr-zed-${source}`, kind: 'dialog', modal: false, frame: 'none', width: 0.9, height: 0.86,
      props: { channel, context, stateKey: `herdr-zed.${source}`, importLabel: 'Import into Tasks' } });
  }
  poll(cx) {
    for (const [channel, entry] of sourceChannels('herdr-zed-tasks')) {
      const { context, source } = entry.request;
      for (const event of consumeSourceEvents(channel)) {
        if (event.type === 'binding') {
          const key = `herdr-zed.${source}-projects`, identity = JSON.stringify(['', folderKey(context.folder)]);
          setShared(key, { ...(shared(key) || {}), [identity]: event.binding });
        } else if (event.type === 'import') {
          closeSourceChannel(channel);
          if (event.snapshot?.source !== source || !event.snapshot?.gid) continue;
          try { this.onImport(context, event.snapshot); }
          catch (error) { notify({ title: 'Could not import task', body: error.message, level: 'error' }); }
          break;
        } else if (event.type === 'close') { closeSourceChannel(channel); break; }
      }
    }
  }
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
