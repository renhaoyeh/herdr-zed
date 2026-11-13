// Same-source project aggregation. The provider keeps its connection, API and original UI.
import { div } from 'gpui-kit';
import { h_flex } from 'gpui-base';
import { shared, theme } from 'herdr';
import { folderKey } from './session-model.js';
import { Button } from './button.js';

const projectKey = project => JSON.stringify([project.machine || '', folderKey(project.folder)]);
const aggregate = gid => typeof gid === 'string' && gid.startsWith('all-projects:');

export class SourceScope {
  constructor(source, target, projects) {
    this.original = source; this.target = target; this.projects = projects;
    this.errors = new Map(); this.origins = new Map();
    this.active = 0; this.waiters = [];
    this.scopeKey = `${target.sourceHub.stateKey}.all-projects.${source.key}`;
    this.source = { ...source,
      projectWorkspace: (credentials, gid) => aggregate(gid) ? Promise.resolve(gid) : source.projectWorkspace(credentials, gid),
      projectTasksPage: (credentials, gid, cursor) => aggregate(gid) ? this.page(credentials, cursor) : source.projectTasksPage(credentials, gid, cursor),
      myProjectTasks: (credentials, gid, workspace) => aggregate(gid) ? this.mine(credentials) : source.myProjectTasks(credentials, gid, workspace),
      projectFields: (credentials, gid) => aggregate(gid) ? this.fields(credentials) : source.projectFields(credentials, gid),
      taskDetails: async (credentials, gid, project) => {
        const origin = aggregate(project) ? this.origins.get(gid) : null;
        const task = await source.taskDetails(credentials, gid, aggregate(project) ? origin?.binding.gid : project);
        return task && aggregate(project) ? this.decorate(task) : task;
      },
    };
    Object.defineProperty(this.source, 'fields', { get: () => this.all()
      ? [...source.fields, { id: 'herdrProject', name: 'Herdr project', width: 180, list: true, card: true, detail: true }]
      : source.fields });
  }
  all() { return shared(this.scopeKey) === true; }
  links() {
    const bindings = shared(this.target.sourceHub.bindingsKey) || {}, seen = new Set();
    return this.projects().flatMap(project => {
      const key = projectKey(project), binding = bindings[key]?.[this.original.key];
      if (!project.folder || seen.has(key) || !binding?.gid) return [];
      seen.add(key); return [{ project, binding }];
    });
  }
  signature() { return JSON.stringify(this.links().map(link => [projectKey(link.project), link.binding])); }
  context(current) { return this.all() ? { folder: `source-all:${this.original.key}`, name: 'All projects' } : current; }
  options(options) {
    return { ...options, source: this.source, sourceScope: this,
      getBinding: () => this.all() ? { gid: `all-projects:${this.signature()}`, workspace: 'all-projects',
        name: `All projects · ${this.links().length} linked`, server: this.browser?.server || '' } : options.getBinding(),
      setBinding: (folder, binding) => { if (!this.all()) options.setBinding(folder, binding); },
    };
  }
  prepare() {
    const signature = this.signature();
    if (signature !== this.originSignature) { this.originSignature = signature; this.origins.clear(); this.errors.clear(); }
    return signature;
  }
  checkServer(credentials, link) {
    if (this.original.server && this.original.normalizeUrl(link.binding.server || '') !== this.original.normalizeUrl(credentials.url))
      throw new Error('The linked server differs from the current connection.');
  }
  tag(task, link) {
    let origin = this.origins.get(task.gid);
    if (!origin) this.origins.set(task.gid, origin = { binding: link.binding, projects: new Map(), task });
    if (origin.binding.gid === link.binding.gid) origin.task = task;
    origin.projects.set(projectKey(link.project), link.project.name || link.project.folder);
    return this.decorate(task);
  }
  decorate(task) { return { ...task, herdrProject: [...(this.origins.get(task.gid)?.projects.values() || [])].join(', ') }; }
  // A source project linked to several Herdr folders is fetched once and labelled with every owning folder.
  targets() {
    const groups = new Map();
    for (const link of this.links()) {
      const key = JSON.stringify([link.binding.server || '', link.binding.gid]);
      if (!groups.has(key)) groups.set(key, { ...link, owners: [] });
      groups.get(key).owners.push(link);
    }
    return [...groups.values()];
  }
  async perform(operation) {
    while (this.active >= 3 && !this.closed) await new Promise(resolve => this.waiters.push(resolve));
    if (this.closed) throw new Error('This source view was closed.');
    this.active++;
    try { return await operation(); }
    finally { this.active--; this.waiters.shift()?.(); }
  }
  async read(targets, credentials, operation, kind) {
    const signature = this.prepare(), values = new Array(targets.length);
    let index = 0;
    const worker = async () => {
      while (index < targets.length) {
        const slot = index++, target = targets[slot], key = JSON.stringify([kind, target.binding.server || '', target.binding.gid]);
        try {
          this.checkServer(credentials, target);
          const value = await this.perform(() => operation(target));
          if (!this.all() || this.signature() !== signature || this.closed) continue;
          this.errors.delete(key); values[slot] = { target, value };
        } catch (error) {
          if (this.all() && this.signature() === signature && !this.closed)
            this.errors.set(key, `${target.owners.map(link => link.project.name || link.project.folder).join(', ')}: ${error.message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, targets.length) }, worker));
    return values.filter(Boolean);
  }
  collect(results, tasks) {
    const rows = new Map();
    for (const { target, value } of results) for (const task of tasks(value)) {
      for (const owner of target.owners) this.tag(task, owner);
      rows.set(task.gid, this.origins.get(task.gid).task);
    }
    return [...rows.values()].map(task => this.decorate(task));
  }
  async page(credentials, cursor) {
    const signature = this.prepare(), targets = this.targets();
    if (!cursor) this.origins.clear();
    const pending = cursor?.signature === signature ? targets.flatMap(target => {
      const key = JSON.stringify([target.binding.server || '', target.binding.gid]);
      return Object.hasOwn(cursor.next, key) ? [{ ...target, cursor: cursor.next[key] }] : [];
    }) : targets;
    const results = await this.read(pending, credentials, target => this.original.projectTasksPage(credentials, target.binding.gid, target.cursor ?? null), 'pages');
    const next = Object.fromEntries(results.filter(result => result.value.next != null).map(({ target, value }) =>
      [JSON.stringify([target.binding.server || '', target.binding.gid]), value.next]));
    return { tasks: this.collect(results, page => page.tasks), next: Object.keys(next).length ? { signature, next } : null };
  }
  async mine(credentials) {
    const results = await this.read(this.targets(), credentials, async target => {
      const workspace = target.binding.workspace || await this.original.projectWorkspace(credentials, target.binding.gid);
      return this.original.myProjectTasks(credentials, target.binding.gid, workspace);
    }, 'mine');
    return this.collect(results, tasks => tasks);
  }
  async fields(credentials) {
    const results = await this.read(this.targets(), credentials, target => this.original.projectFields(credentials, target.binding.gid), 'fields');
    return [...new Map(results.flatMap(({ value }) => value).map(field => [field.gid, field])).values()];
  }
  banner(cx) {
    if (!this.all()) return div().h(0).flex_none();
    const links = this.links(), errors = [...new Set(this.errors.values())];
    if (links.length && !errors.length) return div().h(0).flex_none();
    const t = theme();
    return h_flex().flex_none().px(16).py(8).gap(8).items_center().border_b(1).border_color(t.border).text_size(12)
      .child(div().flex_1().text_color(errors.length ? t.ansi1 : t.muted).child(errors.length
        ? `Some projects could not load. ${errors.join(' · ')}` : `No linked ${this.original.name} projects. Select a sidebar project to link it.`))
      .when(errors.length > 0, el => el.child(Button(`source-scope-retry-${this.original.key}`, t, { variant: 'ghost' })
        .on_click((_event, cx) => { this.errors.clear(); this.origins.clear(); this.browser.reset(); cx.notify(); }).child('Retry')));
  }
  close() { this.closed = true; this.errors.clear(); this.origins.clear(); this.waiters.splice(0).forEach(resolve => resolve()); }
}
