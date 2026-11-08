import { shared, setShared, openOverlay, notify, appHome, exec } from 'herdr';
import { folderKey } from './components/session-model.js';
import { createSourceChannel, sourceChannels, consumeSourceEvents, closeSourceChannel } from './components/source-channel.js';

// Devkits is a consumer of independently running source mods; no provider/UI imports are needed here.
export class TaskSources {
  constructor(onImport = () => {}) { this.onImport = onImport; }
  init(cx) { cx.timer.every(200, cx => this.poll(cx)); }
  open(project, source = 'asana') {
    if (!project || !['asana', 'mantisbt'].includes(source)) return;
    const context = { id: project.id, folder: project.folder, name: project.name, machine: project.machine || null };
    const key = JSON.stringify(['', folderKey(project.folder)]);
    const binding = shared(`devkits.${source}-projects`)?.[key] || null;
    const channel = createSourceChannel({ receiver: 'devkits-tasks', source, context, binding });
    return openOverlay({ mod: `devkits-${source}`, kind: 'dialog', modal: true, frame: 'none', width: 0.9, height: 0.86,
      props: { channel, context, stateKey: `devkits.${source}`, importLabel: 'Import into Tasks' } });
  }
  poll(cx) {
    for (const [channel, entry] of [...sourceChannels('devkits-tasks'), ...sourceChannels('devkits')]) {
      const { context, source } = entry.request;
      for (const event of consumeSourceEvents(channel)) {
        if (event.type === 'binding') {
          const key = `devkits.${source}-projects`, identity = JSON.stringify(['', folderKey(context.folder)]);
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
    const project = shared(`devkits.${source}-projects`)?.[JSON.stringify(['', folderKey(this.folder)])]?.gid || '';
    cx.spawn(async cx => {
      try {
        const result = await exec('node', [`${appHome()}/mods/devkits-${source}/read-task.js`, appHome(), String(task.gid), String(project), task.server || '']);
        const detail = JSON.parse(result.stdout || '{}');
        if (this.detailRequest !== request || this.folder !== request.folder) return;
        if (result.code !== 0 || detail.error) this.detailError = detail.error || 'Could not read this source task.';
        else this.detail = detail;
      } catch (error) { if (this.detailRequest === request) this.detailError = error.message; }
      finally { if (this.detailRequest === request) { this.detailRequest = null; cx.notify(); } }
    });
  }
}
