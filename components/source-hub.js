// A generic host header for original source browsers. Navigation and binding storage are supplied as props.
import { div } from 'gpui-kit';
import { h_flex, v_flex } from 'gpui-base';
import { shared, setShared, spaces, theme, closeOverlay, run } from 'herdr';
import { projectCatalog } from './session-model.js';
import { Button, ToolbarButton } from './button.js';
import { glyph } from './icon.js';
import { followWorkspaceProject, closeWorkspaceView } from './workspace-overlay.js';

// Native blocks own separate mod contexts; the stack retains them when another child is selected.
export function sourceHubLayout(hub, context, workspacePanel) {
  return { type: 'column', resizable: false, children: [
    { type: 'block', size: { px: 48 }, content: { mod: hub.hostMod, props: { view: 'source-hub', sourceHub: hub.stateKey, context, workspacePanel } } },
    { type: 'stack', id: hub.stack, active: `${hub.stack}-${hub.selected}`, children: hub.tabs.map(tab => ({
      type: 'block', id: `${hub.stack}-${tab.id}`, content: { mod: tab.mod, props: { ...tab.props, context,
        sourceHub: hub.stateKey, sourceTab: tab.id, stateKey: `${hub.stateKey}.${tab.id}`, workspaceAction: hub.workspaceAction, workspacePanel } },
    })) },
  ] };
}

export function resolveSourceHub(target) {
  if (typeof target.sourceHub !== 'string') return target;
  const config = shared(`${target.sourceHub}.config`);
  return { ...target, sourceHub: { ...config, selected: target.sourceTab || config.selected } };
}

export class SourceHub {
  constructor(target) { this.target = target; }
  init() { followWorkspaceProject(); }
  sync() {
    const hub = this.target.sourceHub;
    this.selected = shared(`${hub.stateKey}.selected`) || hub.selected;
    const projects = this.projects = projectCatalog(spaces(), shared('herdr-zed.projects') || [], shared('herdr-zed.project-roots') || {}, shared('herdr-zed.selected-project'), shared('herdr-zed.project-order') || []);
    const current = projects.find(project => project.active);
    this.target.context = current ? { id: current.id, folder: current.folder, name: current.name, machine: current.machine || null } : { folder: '', name: '' };
    return current;
  }
  open(tab) {
    if (!tab) return null;
    const hub = this.target.sourceHub;
    if (tab.id === (shared(`${hub.stateKey}.selected`) || hub.selected)) return this.target.workspacePanel;
    setShared(`${hub.stateKey}.selected`, tab.id);
    run('layout.select', { stack: hub.stack, child: `${hub.stack}-${tab.id}` });
    return this.target.workspacePanel;
  }
  toggleScope() {
    const hub = this.target.sourceHub, source = shared(`${hub.stateKey}.selected`) || hub.selected;
    const key = `${hub.stateKey}.all-projects.${source}`;
    this.setScope(shared(key) !== true);
  }
  setScope(allProjects) {
    const hub = this.target.sourceHub, source = shared(`${hub.stateKey}.selected`) || hub.selected;
    setShared(`${hub.stateKey}.all-projects.${source}`, allProjects === true);
  }
  render() {
    const t = theme(), hub = this.target.sourceHub;
    this.sync();
    const scopeKey = `${hub.stateKey}.all-projects.${this.selected}`, all = shared(scopeKey) === true;
    const nav = (id, label, selected, action) => Button(id, t, { variant: 'ghost' }).h(30).px(12)
      .when(selected, el => el.bg(t.selected)).accessibility_label(`${label}${selected ? ', selected' : ''}`)
      .on_click(action).child(label);
    return v_flex().flex_none().bg(t.background).text_color(t.foreground).text_size(13)
      .child(h_flex().h(48).flex_none().px(16).gap(8).items_center().border_b(1).border_color(t.border)
        .child(glyph('columns-3', 16)).child(div().font_semibold().child(hub.title))
        .children(hub.tabs.map(tab => nav(`source-hub-${tab.id}`, tab.title, this.selected === tab.id, () => this.open(tab))))
        .child(div().flex_1())
        .when(hub.tabs.find(tab => tab.id === this.selected)?.scope !== false,
          el => el.child(nav('source-hub-all-projects', 'All projects', all, () => this.toggleScope())))
        .child(ToolbarButton('source-hub-close', t, { icon: true }).tooltip(`Close ${hub.title}`).accessibility_label(`Close ${hub.title}`)
          .on_click(() => closeWorkspaceView()).child(glyph('close', 16))));
  }
}
