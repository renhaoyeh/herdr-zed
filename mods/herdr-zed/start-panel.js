import { div } from 'gpui-kit';
import { v_flex } from 'gpui-base';
import { Button } from './components/button.js';
import { Empty, EmptyTitle, EmptyDescription } from './components/empty.js';
import { glyph, AgentIcon } from './components/icon.js';

// The original empty-state geometry, using only Herdr's native program discovery.
export const startPanel = {
  startAgents(machine, cx) {
    this.programs ||= new Map();
    const key = machine || '';
    if (!this.programs.has(key)) {
      const entry = { items: null }; this.programs.set(key, entry);
      cx.spawn(async cx => {
        try { entry.items = await this.cachedAgents(machine); }
        catch { entry.items = []; entry.error = 'Could not discover installed programs.'; }
        cx.notify();
      });
    }
    return this.programs.get(key);
  },
  welcomeView(t, cx) {
    return div().id('welcome').size_full().bg(t.background).text_color(t.foreground).flex().items_center().justify_center().p(24)
      .child(v_flex().w_full().max_w(420).gap(24)
        .child(Empty(t).gap(8).child(EmptyTitle().child('herdr-zed'))
          .child(EmptyDescription(t).child('Open a folder to start a thread.')))
        .child(Button('welcome-open-folder', t).w_full().h(36).gap(8)
          .on_click((_event, cx) => this.openProject(cx)).child(glyph('folder-open')).child('Open folder…')));
  },
  projectStartView(project, t, cx) {
    if (!project) return div().size_full().bg(t.background);
    const programs = this.startAgents(project.machine, cx);
    const target = { space: project.pending ? null : project.id, folder: project.folder, projectName: project.name, machine: project.machine || null };
    return div().id('project-start').size_full().bg(t.background).text_color(t.foreground).flex().items_center().justify_center().p(24)
      .child(v_flex().w_full().max_w(360).gap(16)
        .child(v_flex().gap(4).child(div().text_size(15).font_medium().child('Start a thread'))
          .child(div().truncate().text_size(12).text_color(t.muted).child(project.name)))
        .child(v_flex().id('project-start-list').flex_none().gap(1)
          .children([null, ...(programs.items || [])].map(agent => Button(`start-panel-${agent?.key || 'terminal'}`, t, { variant: 'ghost' })
            .w_full().h(36).px(12).gap(10).justify_start().accessibility_label(`Start ${agent?.name || 'Terminal'}`)
            .on_click(() => this.startThread(agent, target))
            .child(div().size(16).flex_none().flex().items_center().justify_center().text_color(t.muted).child(AgentIcon(agent, t)))
            .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.foreground).child(agent?.name || 'Terminal'))))
          .when(!programs.items || programs.error, el => el.child(div().py(8).text_size(12).text_color(t.muted)
            .child(programs.error || 'Looking for programs…')))));
  },
};
