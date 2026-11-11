// Shared: edit components/task-source.js, then npm run sync:shared.
import { InputState } from 'gpui-base';
import { filterTasks, sourceTaskSnapshot } from './task-source-model.js';

export class TaskSourceProjectPicker {
  constructor({ source, getBinding = () => null, onSelect = () => {}, onClose = () => {} } = {}) {
    this.source = source; this.getBinding = getBinding; this.onSelect = onSelect; this.onClose = onClose;
  }

  close() { this.onClose(); }

  init(target, cx) {
    this.folder = target.folder;
    this.projects = []; this.index = 0; this.loading = true; this.error = null;
    this.handle = cx.focus_handle();
    this.search = InputState.new({ placeholder: `Search ${this.source.name} projects` });
    this.search.on('change', (_event, cx) => { this.index = 0; this.find(cx); });
    this.search.on('submit', () => this.choose(this.projects[this.index]));
    this.search.focus();
    this.find(cx);
  }

  find(cx) {
    const query = this.search.value();
    this.loading = true; cx.notify();
    cx.spawn(async cx => {
      try {
        const connection = await this.source.readConnection();
        if (!connection?.token) throw new Error(`Connect ${this.source.name} first.`);
        const projects = await this.source.searchProjects(this.source.server ? connection : connection.token, query);
        if (this.search.value() !== query) return;
        this.projects = projects; this.error = null;
      } catch (error) { if (this.search.value() === query) this.error = error.message; }
      if (this.search.value() === query) this.loading = false;
      cx.notify();
    });
  }

  choose(project) {
    if (!project) return;
    this.onSelect(project);
    this.close();
  }

}

export class TaskSourceController {
  constructor({ source, state, getBinding = () => null, setBinding = () => {}, onImport, importLabel = 'Import', onClose = () => {}, openProjectPicker } = {}) {
    this.source = source; this.state = state; this.getBinding = getBinding; this.setBinding = setBinding;
    this.onImport = onImport; this.onClose = onClose; this.openProjectPicker = openProjectPicker;
    this.importLabel = importLabel;
  }

  readState(key) { return this.state?.get(key); }
  writeState(key, value) { this.state?.set(key, value); }
  selectionScope() { return JSON.stringify([this.folder || '', this.fieldScope()]); }
  rememberSelection(gid) {
    if (!this.folder || !this.binding()) return;
    this.writeState('browser-selection', { ...(this.readState('browser-selection') || {}), [this.selectionScope()]: gid });
  }
  clearIssue(cx) {
    this.rememberSelection(null);
    this.selected = null; this.detail = null; this.detailError = null; this.detailRequest = null;
    cx.notify();
  }
  snapshot(task = this.detail) { return sourceTaskSnapshot(this.source, task, this.server); }
  import(task = this.detail) {
    if (!task || task.completed || (!Array.isArray(task.comments) && !task.commentsError)) return false;
    if (!this.onImport) return false;
    this.onImport(this.snapshot(task)); return true;
  }

  render(project, cx) { return this.panel(project, task => this.import(task), this.onClose, cx); }
  credentials() { return this.source.server ? { url: this.server, token: this.token } : this.token; }
  binding() {
    const bound = this.getBinding(this.folder);
    return this.source.server && bound?.server !== this.server ? null : bound;
  }

  fieldScope() { return JSON.stringify([this.source.key, this.source.server ? this.server : '', this.binding()?.gid || '']); }
  fieldCatalog() {
    const fields = [...(this.source.fields || [])], seen = new Set();
    const schema = this.fieldSchema?.scope === this.fieldScope() ? this.fieldSchema.fields : [];
    const tasks = [...(this.mine || []), ...(this.all?.tasks || []), this.detail].filter(Boolean);
    for (const field of [...schema, ...tasks.flatMap(task => task.customFields || [])]) {
      if (!field.gid || seen.has(field.gid)) continue;
      seen.add(field.gid);
      fields.push({ id: `custom:${field.gid}`, name: field.name, type: field.type, width: 140, detail: true });
    }
    return fields;
  }
  fieldOptions(surface) {
    const fields = this.fieldCatalog(), saved = this.readState('field-display')?.[this.fieldScope()]?.[surface] || [];
    const order = [...saved.map(item => item.id), ...fields.map(field => field.id)];
    return [...new Set(order)].flatMap(id => {
      const field = fields.find(field => field.id === id);
      return field ? [{ ...field, visible: saved.find(item => item.id === id)?.visible ?? Boolean(field[surface]) }] : [];
    });
  }
  displayFields(surface) { return this.fieldOptions(surface).filter(field => field.visible); }
  fieldValue(task, field) {
    if (field.id.startsWith('custom:')) return task.customFields?.find(item => `custom:${item.gid}` === field.id)?.displayValue || '—';
    const value = task[field.id];
    return Array.isArray(value) ? value.join(', ') || '—' : value == null || value === '' ? '—' : String(value);
  }
  changeField(surface, id, direction, cx) {
    const options = this.fieldOptions(surface).map(field => ({ id: field.id, visible: field.visible }));
    const index = options.findIndex(field => field.id === id);
    if (index < 0) return;
    if (!direction) options[index].visible = !options[index].visible;
    else {
      const target = index + direction;
      if (target < 0 || target >= options.length) return;
      [options[index], options[target]] = [options[target], options[index]];
    }
    this.saveFieldOptions(surface, options, cx);
  }
  saveFieldOptions(surface, options, cx) {
    const saved = this.readState('field-display') || {}, scope = this.fieldScope(), previous = saved[scope] || {};
    // Retain temporarily unavailable fields and other projects' choices.
    const missing = (previous[surface] || []).filter(item => !options.some(field => field.id === item.id));
    this.writeState('field-display', { ...saved, [scope]: { ...previous, [surface]: [...options, ...missing] } });
    cx.notify();
  }
  startFieldDrag(surface, id, cx) {
    this.fieldDrag = { scope: this.fieldScope(), surface, id, target: id };
    cx.notify();
  }
  cancelFieldDrag(cx) {
    if (!this.fieldDrag) return;
    this.fieldDrag = null; cx.notify();
  }
  hoverField(surface, id, cx) {
    const drag = this.fieldDrag;
    if (!drag) return;
    if (drag.scope !== this.fieldScope() || drag.surface !== surface) { this.cancelFieldDrag(cx); return; }
    if (drag.target !== id) { drag.target = id; cx.notify(); }
  }
  dropField(surface, target, cx) {
    const drag = this.fieldDrag;
    this.cancelFieldDrag(cx);
    if (!drag || drag.scope !== this.fieldScope() || drag.surface !== surface || drag.id === target) return;
    const options = this.fieldOptions(surface).map(({ id, visible }) => ({ id, visible }));
    const from = options.findIndex(field => field.id === drag.id), to = options.findIndex(field => field.id === target);
    if (from < 0 || to < 0) return;
    options.splice(to, 0, options.splice(from, 1)[0]);
    this.saveFieldOptions(surface, options, cx);
  }
  fieldDragKey(event, surface, id, cx) {
    if (event.key === 'escape' && this.fieldDrag) { this.cancelFieldDrag(cx); cx.stop_propagation(); }
    else if (event.modifiers?.alt && ['up', 'down'].includes(event.key)) {
      this.cancelFieldDrag(cx);
      this.changeField(surface, id, event.key === 'up' ? -1 : 1, cx); cx.stop_propagation();
    }
  }
  syncFields(cx, retry = false) {
    const scope = this.fieldScope(), credentials = this.credentials(), gid = this.binding()?.gid;
    if (this.needsToken !== false || !this.binding()?.gid || !this.source.projectFields || this.disposed) return;
    if (!retry && this.fieldSchema?.scope === scope && this.fieldSchema.credentials === JSON.stringify(credentials)) return;
    const state = { scope, credentials: JSON.stringify(credentials), fields: [], loading: true, error: null };
    this.fieldSchema = state;
    cx.spawn(async cx => {
      try {
        const fields = await this.source.projectFields(credentials, gid);
        if (this.fieldSchema !== state || this.fieldScope() !== scope || this.disposed) return;
        state.fields = fields;
      } catch (error) {
        if (this.fieldSchema !== state || this.fieldScope() !== scope || this.disposed) return;
        state.error = error.message;
      }
      state.loading = false; cx.notify();
    });
  }
  dispose() { this.disposed = true; this.fieldSchema = null; this.detailRequest = null; this.page++; }

  init(cx) {
    this.handle = cx.focus_handle();
    this.tab = this.readState('tab') === 'all' ? 'all' : 'mine';
    this.folder = undefined;
    this.reset();
    this.search = InputState.new({ placeholder: 'Search tasks' });
    this.search.on('change', (_event, cx) => cx.notify());
    this.tokenInput = InputState.new({ placeholder: 'Personal access token' });
    this.tokenInput.set_masked(true);
    this.tokenInput.on('change', (_event, cx) => { this.tokenCopied = false; cx.notify(); });
    this.tokenInput.on('submit', (_event, cx) => this.saveToken(cx));
    if (this.source.server) {
      this.serverInput = InputState.new({ placeholder: 'https://mantis.example.com' });
      this.serverInput.on('submit', (_event, cx) => this.saveToken(cx));
    }
  }

  reset() {
    this.mine = null; this.all = { tasks: [], next: null, loaded: false }; this.loadingMore = false; this.page = (this.page || 0) + 1;
    this.subtasks = new Map(); this.expanded = new Set(); this.loadedGid = null; this.loading = false;
    this.selected = null; this.cursor = null; this.detail = null; this.detailError = null; this.error = null;
    this.detailRequest = null;
  }

  fail(error) {
    this.error = error.message;
    if (error.unauthorized) { this.needsToken = true; this.loadedGid = null; this.tokenInput.focus(); }
  }

  // The token is unknown (null) until it has been read, so nothing else shows before then.
  // Each Devkits project keeps its own list, selection and preview while another project is shown.
  open(project, cx) {
    const keys = ['mine', 'all', 'subtasks', 'expanded', 'loadedGid', 'selected', 'cursor', 'detail', 'detailError', 'error'];
    this.states ||= new Map();
    if (this.folder) this.states.set(this.folder, { ...Object.fromEntries(keys.map(key => [key, this[key]])),
      // Unfinished loads are dropped when the project changes, so they start again on return.
      loadedGid: this.loading ? null : this.loadedGid, query: this.search.value() });
    this.folder = project?.folder || null;
    this.reset();
    const saved = this.states.get(this.folder);
    if (saved) Object.assign(this, Object.fromEntries(keys.map(key => [key, saved[key]])));
    this.search.set_value(saved?.query || '');
    if (!this.folder) return;
    if (this.selected && !this.detail && this.token) this.show({ gid: this.selected }, cx, { restoring: true });
    if (this.token) { this.needsToken = false; return; }
    this.needsToken = null;
    cx.spawn(async cx => {
      const connection = await this.source.readConnection();
      this.token = connection?.token || null;
      this.server = connection?.url || '';
      this.serverInput?.set_value(this.server);
      this.needsToken = !this.token;
      if (this.needsToken) this.tokenInput.focus();
      cx.notify();
    });
  }

  // Loads whenever the bound Asana project differs from the one shown, including after the project menu changes it.
  // Mine loads first and is small; All loads a page only when it is shown, and more on request.
  sync(cx) {
    const bound = this.binding(), gid = bound?.gid || null;
    if (this.needsToken !== false) return;
    if (this.settingsOpen) this.syncFields(cx);
    if (gid !== this.loadedGid) {
      const folder = this.folder;
      this.reset(); this.loadedGid = gid;
      if (!gid) return;
      const selected = this.readState('browser-selection')?.[this.selectionScope()];
      if (selected) this.show({ gid: selected }, cx, { restoring: true });
      this.load(cx, async () => {
        let workspace = bound.workspace;
        if (!workspace) {
          workspace = await this.source.projectWorkspace(this.credentials(), gid);
          if (this.folder !== folder || this.loadedGid !== gid) return;
          this.setBinding(folder, { ...bound, workspace });
        }
        const mine = await this.source.myProjectTasks(this.credentials(), gid, workspace);
        if (this.folder !== folder || this.loadedGid !== gid) return;
        this.mine = mine;
      });
    }
    if (gid && this.tab === 'all' && !this.all.loaded) this.more(cx);
  }

  load(cx, work) {
    const folder = this.folder, gid = this.loadedGid;
    this.loading = true;
    cx.spawn(async cx => {
      try { await work(); } catch (error) { if (this.loadedGid === gid && this.folder === folder) this.fail(error); }
      if (this.loadedGid === gid && this.folder === folder) this.loading = false;
      cx.notify();
    });
  }

  more(cx) {
    if (this.loadingMore || (this.all.loaded && !this.all.next)) return;
    const request = this.page, gid = this.loadedGid;
    this.loadingMore = true;
    cx.spawn(async cx => {
      try {
        const page = await this.source.projectTasksPage(this.credentials(), gid, this.all.next);
        if (this.page === request) this.all = { tasks: [...this.all.tasks, ...page.tasks], next: page.next, loaded: true };
      } catch (error) { if (this.page === request) this.fail(error); }
      if (this.page === request) this.loadingMore = false;
      cx.notify();
    });
  }

  openSettings(cx) {
    this.settingsOpen = true;
    this.tokenCopied = false;
    this.tokenInput.set_value(this.token || '');
    this.serverInput?.set_value(this.server || '');
    this.error = null;
    cx.notify();
  }

  saveToken(cx) {
    const token = this.tokenInput.value().trim();
    if (this.tokenBusy) return;
    if (!token) { this.error = 'Enter a personal access token.'; cx.notify(); return; }
    const url = this.serverInput?.value().trim() || '';
    if (token === this.token && (!this.source.server || url === this.server) && this.needsToken === false) {
      this.settingsOpen = false; this.tokenInput.set_value(''); this.error = null; cx.notify(); return;
    }
    this.tokenBusy = true;
    cx.spawn(async cx => {
      try {
        const connection = this.source.server ? { url: this.source.normalizeUrl(url), token } : { token };
        if (this.source.validateConnection) await this.source.validateConnection(connection);
        await this.source.saveConnection(connection);
        this.server = connection.url; this.token = token; this.needsToken = false; this.settingsOpen = false;
        this.states?.clear(); this.reset(); this.tokenInput.set_value('');
      }
      catch (error) { this.error = error.message; }
      this.tokenBusy = false; cx.notify();
    });
  }

  copyToken(cx) {
    const token = this.tokenInput.value().trim();
    if (!token) return;
    cx.write_to_clipboard(token);
    this.tokenCopied = true;
    cx.notify();
  }

  clearToken(cx) {
    if (this.tokenBusy) return;
    this.tokenBusy = true;
    cx.spawn(async cx => {
      try {
        await this.source.saveConnection({ url: this.server || '', token: '' });
        this.token = null; this.needsToken = true; this.states?.clear(); this.reset();
        this.settingsOpen = true; this.tokenInput.set_value('');
      } catch (error) { this.error = error.message; }
      this.tokenBusy = false; cx.notify();
    });
  }

  toggleExpanded(task, cx) {
    if (this.expanded.delete(task.gid)) { cx.notify(); return; }
    this.expanded.add(task.gid);
    if (!this.subtasks.has(task.gid)) this.loadSubtasks(task, cx);
    cx.notify();
  }

  loadSubtasks(task, cx) {
    const request = this.page, credentials = this.credentials();
    this.subtasks.set(task.gid, null);
    cx.spawn(async cx => {
      try {
        const subtasks = await this.source.openSubtasks(credentials, task.gid);
        if (this.page === request) this.subtasks.set(task.gid, subtasks.map(sub => ({ ...sub, parent: task.name })));
      }
      catch (error) { if (this.page === request) { this.subtasks.delete(task.gid); this.expanded.delete(task.gid); this.fail(error); } }
      cx.notify();
    });
  }

  // Keep the selected preview and its pending read; changing sources reads fresh.
  show(task, cx, { restoring = false } = {}) {
    const gid = task.gid;
    if (this.selected === gid && (this.detail || this.detailRequest)) return;
    const request = { folder: this.folder, gid };
    this.detailRequest = request;
    if (!restoring) this.rememberSelection(gid);
    this.selected = gid; this.cursor = gid; this.detail = null; this.detailError = null;
    cx.spawn(async cx => {
      try {
        const detail = await this.source.taskDetails(this.credentials(), gid, this.binding()?.gid);
        if (this.detailRequest !== request || this.selected !== gid || this.folder !== request.folder) return;
        if (!detail || detail.completed) this.detailError = `This task was completed or deleted in ${this.source.name}.`;
        else {
          this.detail = detail;
          if (detail.subtasks && !this.subtasks.has(gid)) this.loadSubtasks(detail, cx);
          if (!detail.comments) this.loadComments(detail, cx);
        }
      } catch (error) { if (this.detailRequest === request) { this.detailError = error.message; if (error.unauthorized) this.fail(error); } }
      finally { if (this.detailRequest === request) { this.detailRequest = null; cx.notify(); } }
    });
    // Restoration runs inside render; its loading state is already part of that frame.
    if (!restoring) cx.notify();
  }

  // Comments arrive after the preview opens; include them in the imported snapshot.
  loadComments(detail, cx) {
    cx.spawn(async cx => {
      try {
        const comments = await this.source.taskComments(this.credentials(), detail.gid);
        if (this.detail === detail) this.detail = { ...detail, comments };
      } catch (error) { if (this.detail === detail) this.detail = { ...detail, comments: [], commentsError: error.message }; }
      cx.notify();
    });
  }

  visible() {
    const query = this.search.value();
    const base = this.tab === 'mine' ? this.mine || [] : this.all.tasks;
    return filterTasks(base, query);
  }

  // Sections keep Asana's order, as in its List and Board views.
  groups() {
    const groups = [];
    for (const task of this.visible()) {
      const name = task.section || 'No section';
      let group = groups.find(group => group.name === name);
      if (!group) groups.push(group = { name, tasks: [] });
      group.tasks.push(task);
    }
    return groups;
  }

  rows() {
    const nested = !this.search.value().trim() && this.view() === 'list';
    return this.groups().flatMap(group => group.tasks.flatMap(task => [{ task, depth: 0 },
      ...(nested && this.expanded.has(task.gid) ? (this.subtasks.get(task.gid) || []).map(sub => ({ task: sub, depth: 1 })) : [])]));
  }

  view() { return this.readState('view') === 'board' ? 'board' : 'list'; }

  navigate(event, cx) {
    const rows = this.rows();
    const index = rows.findIndex(row => row.task.gid === this.cursor);
    const row = rows[index];
    if (event.key === 'down' || event.key === 'up') {
      const next = rows[Math.max(0, Math.min(rows.length - 1, index + (event.key === 'down' ? 1 : -1)))];
      if (!next) return;
      this.show(next.task, cx);
    } else if (event.key === 'escape' && this.selected) { this.clearIssue(cx); }
    else if ((event.key === 'right' || event.key === 'left') && row?.task?.subtasks && !row.depth
      && this.expanded.has(row.task.gid) === (event.key === 'left')) this.toggleExpanded(row.task, cx);
    else return;
    cx.stop_propagation(); cx.notify();
  }

}
