import { div } from 'gpui-kit';
import { v_flex, h_flex } from 'gpui-base';
import { shared, setShared } from 'herdr';
import { launcherChoices, launcherLabel, isAccountLauncher } from './model.js';
import { Button } from './components/button.js';
import { DropdownMenuLabel } from './components/dropdown-menu.js';
import { Empty, EmptyTitle, EmptyDescription } from './components/empty.js';
import { glyph, AgentIcon } from './components/icon.js';
import { openAgentSettings, noAccount } from './session-menu.js';

const providers = [
  { key: 'claude', name: 'Claude Code', install: 'npm install -g @anthropic-ai/claude-code' },
  { key: 'codex', name: 'Codex CLI', install: 'npm install -g @openai/codex' },
];
const starting = new Set();

// Like Zed's welcome and empty agent panel: nothing needs configuring before the first thread.
// Mixed into the Devkits view, which provides cachedAgents, availableAgents, startThread and openProject.
export const startPanel = {
  // Detected agents for a machine, loading them once when this view has not seen them yet.
  startAgents(machine, cx) {
    const key = JSON.stringify(machine || null), cached = shared('devkits.agent-cache')?.[key];
    if (cached) return this.availableAgents(cached, machine);
    if (!starting.has(key)) {
      starting.add(key);
      cx.spawn(async cx => { try { await this.cachedAgents(machine); } catch {} finally { starting.delete(key); } cx.notify(); });
    }
    return null;
  },

  recheckAgents(cx) {
    setShared('devkits.agent-cache', {});
    this.startAgents(null, cx);
    cx.notify();
  },

  section(id, label, t) {
    return v_flex().id(id).w_full().flex_none().gap(6).child(DropdownMenuLabel(t).px(0).child(label));
  },

  row(id, icon, name, detail, t) {
    return h_flex().id(id).h(36).px(12).gap(10).items_center()
      .child(div().size(16).flex_none().flex().items_center().justify_center().text_color(t.muted).child(icon))
      .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.foreground).child(name))
      .when(Boolean(detail), el => el.child(div().flex_none().text_size(12).text_color(t.muted).child(detail)));
  },

  // No project is open: open a folder, and see which agents this computer has.
  welcomeView(t, cx) {
    const agents = this.startAgents(null, cx);
    const accounts = (agents || []).filter(agent => isAccountLauncher(agent) && !agent.profileKey).length;
    const profiles = (agents || []).filter(agent => agent.profileKey).length;
    const summary = [accounts && `${accounts} account${accounts === 1 ? '' : 's'}`, profiles && `${profiles} profile${profiles === 1 ? '' : 's'}`]
      .filter(Boolean).join(' · ');
    return div().id('welcome').size_full().bg(t.background).text_color(t.foreground).flex().items_center().justify_center().p(24)
      .child(v_flex().w_full().max_w(420).gap(24)
        .child(Empty(t).gap(8)
          .child(EmptyTitle().child('Devkits'))
          .child(EmptyDescription(t).child('Open a folder to start a thread with an agent.')))
        .child(Button('welcome-open-folder', t).w_full().h(36).gap(8).on_click((_event, cx) => this.openProject(cx))
          .child(glyph('folder-open')).child('Open folder…'))
        .child(this.section('welcome-agents', 'AGENTS ON THIS COMPUTER', t)
          .child(v_flex().flex_none().border(1).border_color(t.border)
            .when(!agents, el => el.child(div().p(12).text_size(12).text_color(t.muted).child('Looking for agents…')))
            .when(Boolean(agents), el => el.children(providers.map((provider, index) => {
              const agent = agents.find(item => item.key === provider.key);
              return v_flex().flex_none().when(index > 0, el => el.border_t(1).border_color(t.border))
                .child(this.row(`welcome-agent-${provider.key}`, agent ? AgentIcon(agent, t) : glyph('circle-dashed'),
                  provider.name, agent ? this.accountIdentity(agent).email || 'Ready' : 'Not installed', t))
                .when(!agent, el => el.child(div().px(12).pb(10).pl(38).text_size(12).font_family('Geist Mono').text_color(t.muted)
                  .child(provider.install)));
            })))
            .when(Boolean(summary), el => el.child(div().px(12).py(8).border_t(1).border_color(t.border).text_size(12)
              .text_color(t.muted).child(summary))))
          .child(h_flex().flex_none().gap(8).mt(4)
            .child(Button('welcome-agent-settings', t, { variant: 'secondary' }).h(28).gap(6)
              .on_click(() => openAgentSettings(null, 'accounts')).child(glyph('settings')).child('Agent settings…'))
            .when(Boolean(agents) && providers.some(provider => !agents.some(agent => agent.key === provider.key)), el => el
              .child(Button('welcome-recheck-agents', t, { variant: 'ghost' }).h(28).gap(6)
                .on_click((_event, cx) => this.recheckAgents(cx)).child(glyph('refresh-cw')).child('Check again'))))));
  },

  // A project without an open document or thread: start one from the same list Add session shows.
  projectStartView(project, t, cx) {
    if (!project) return div().size_full().bg(t.background);
    const agents = this.startAgents(project.machine, cx);
    const hidden = shared('devkits.hidden-launchers') || [];
    const choices = launcherChoices(agents || [], shared('devkits.launcher-order') || []).filter(choice => !hidden.includes(choice.key));
    const target = { space: project.pending ? null : project.id, folder: project.folder, projectName: project.name };
    const remembered = agents ? this.defaultThreadChoice(project, agents) : {};
    const last = remembered.auto ? 'auto' : remembered.agent?.key;
    const auto = agents && this.autoThreadAgent(agents, project.machine);
    const shortcut = this.newThreadShortcut();
    const item = (id, agent, name, key, start) => Button(id, t, { variant: 'ghost' }).w_full().h(36).px(12).gap(10).justify_start()
      .accessibility_label(`Start ${name}`).on_click(start)
      .child(div().size(16).flex_none().flex().items_center().justify_center().text_color(t.muted).child(AgentIcon(agent, t)))
      .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(this.accountName(agent, name) === noAccount ? t.muted : t.foreground).child(this.accountName(agent, name)))
      .when(Boolean(shortcut && key === last), el => el.child(div().flex_none().text_size(11).text_color(t.muted).child(shortcut)));
    const rows = choices.flatMap(choice => [
      item(choice.agent ? `start-panel-${choice.agent.key}` : 'start-panel-terminal', choice.agent, choice.name, choice.agent?.key,
        () => this.startThread(choice.agent, target)),
      ...(choice.group === 0 && auto ? [item('start-panel-auto', auto, `Auto · ${launcherLabel(auto.name)}`, 'auto',
        () => this.startThread(this.autoThreadAgent(agents, project.machine), target, { auto: true }))] : []),
    ]);
    return div().id('project-start').size_full().bg(t.background).text_color(t.foreground).flex().items_center().justify_center().p(24)
      .child(v_flex().w_full().max_w(360).gap(16)
        .child(v_flex().gap(4)
          .child(div().text_size(15).font_medium().child('Start a thread'))
          .child(div().truncate().text_size(12).text_color(t.muted).child(project.name)))
        .child(v_flex().id('project-start-list').flex_none().gap(1)
          .when(!agents, el => el.child(div().py(8).text_size(12).text_color(t.muted).child('Loading agents…')))
          .children(rows))
        .child(h_flex().flex_none()
          .child(Button('project-start-settings', t, { variant: 'ghost' }).h(28).px(8).gap(6).text_color(t.muted)
            .on_click(() => openAgentSettings(project.pending ? null : project.id, project.machine ? 'agents' : 'accounts'))
            .child(glyph('settings')).child('Agent settings…'))));
  },
};
