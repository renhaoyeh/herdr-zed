import { div } from 'gpui-kit';
import { v_flex, h_flex, TextareaState, Textarea } from 'gpui-base';
import { shared, setShared, window } from 'herdr';
import { Button } from './components/button.js';
import { Select, SelectState } from './components/select.js';
import { Empty, EmptyTitle, EmptyDescription } from './components/empty.js';
import { glyph, AgentIcon } from './components/icon.js';
import { activeLauncher } from './extensions.js';
import { COMPOSE_TAB } from './workspace-editor.js';
import { composerChoices, composerOptionShown, launchIntent } from './components/extension-contract.js';

// The program chosen last in each project, so the composer opens on it.
export const START_AGENT_KEY = 'herdr-zed.start-agent';
// New thread's request to the editor view: the project (startProjectKey) whose New thread tab to open.
export const COMPOSE_KEY = 'herdr-zed.compose';
// ARCHITECTURE §3.1 Composer: shell -> launcher. The shell only appends; the launcher takes its own intents off.
export const LAUNCH_INTENTS = 'herdr-zed.launch.intents';
// The most fields a launcher choice shows; later ones are not drawn.
const START_FIELDS = 6;
export const startProjectKey = project => JSON.stringify([project.machine || '', (project.folder || '').replace(/\\/g, '/').replace(/\/+$/, '') || project.id]);
export function startChoice(programs, project, remembered = {}) {
  const key = remembered[startProjectKey(project)];
  return key === 'terminal' ? null : programs.find(agent => agent.key === key) || programs[0] || null;
}

// Start a thread: describe the task, pick the program and its session fields, then Ctrl+Enter (Cmd+Enter on macOS) or
// Start. Plain Enter adds a line; nothing is sent by accident. The text becomes the agent's first message; a Terminal
// starts empty. With a launcher extension, the programs and their fields (model, effort, Fast...) are the ones it
// publishes, and Start hands it a launch intent (ARCHITECTURE §3.1 Composer); without one, native programs start as is.
export const startPanel = {
  initStartPanel(cx) {
    this.startTask = TextareaState.new({ placeholder: 'Describe the task (optional)…' });
    this.startTask.set_auto_grow(4, 12);
    this.startTask.on('change', (_event, cx) => cx.notify());
    this.startTask.on('submit', (event, cx) => { if (event?.secondary) this.submitStart(cx); });
    this.startSelect = new SelectState(cx);
    // Select states hold a focus handle, so they exist before render: one per launcher field position.
    this.startFieldSelects = Array.from({ length: START_FIELDS }, () => new SelectState(cx));
    // Shared state does not repaint this view: redraw when the launcher republishes its composer choices.
    cx.timer?.every(500, cx => {
      const launcher = activeLauncher(), seen = launcher ? shared(`herdr-zed.composer.${launcher.id}`)?.updatedAt ?? null : null;
      if (seen !== this.startSeen) { this.startSeen = seen; cx.notify(); }
    });
  },
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
  chooseStartAgent(project, key, cx) {
    setShared(START_AGENT_KEY, { ...(shared(START_AGENT_KEY) || {}), [startProjectKey(project)]: key });
    cx.notify();
  },
  submitStart(cx) {
    const start = this.startTarget;
    if (!start) return;
    const task = start.takesTask ? this.startTask.value().trim() : '';
    if (start.intent) {
      // ARCHITECTURE §3.1 Composer: the launcher prepares the account and emits the launch request.
      setShared(LAUNCH_INTENTS, [...(shared(LAUNCH_INTENTS) || []).filter(intent => intent?.expiresAt > Date.now()),
        launchIntent({ ...start.intent, target: start.target, ...(task ? { task } : {}), now: Date.now() })]);
    } else if (start.picker) this.openLauncher(start.project, task || null);
    else this.startThread(start.agent, { ...start.target, ...(task ? { task } : {}) });
    this.startTask.set_value('');
    // Starting closes the New thread tab; the new thread takes the view.
    if (this.editor?.session?.compose) this.editor.closeItem(COMPOSE_TAB, cx);
    cx.notify();
  },
  // The values of one launcher choice: its fields' published defaults, then what was picked here. A select whose value
  // the other picks no longer allow falls back to its first offered option.
  startValues(choice) {
    this.startPicked ||= {};
    const picked = this.startPicked[choice.key] || {}, values = {};
    for (const field of choice.fields) values[field.id] = field.id in picked ? picked[field.id] : field.value;
    for (const field of choice.fields) {
      if (field.type !== 'select') continue;
      const shown = field.options.filter(option => composerOptionShown(option, values));
      if (!shown.some(option => option.key === values[field.id])) values[field.id] = shown[0]?.key ?? field.value;
    }
    return values;
  },
  pickStartValue(choice, id, value, cx) {
    this.startPicked ||= {};
    this.startPicked[choice.key] = { ...(this.startPicked[choice.key] || {}), [id]: value };
    cx.notify();
  },
  projectStartView(project, t, cx) {
    if (!project) return div().size_full().bg(t.background);
    const target = { space: project.pending ? null : project.id, folder: project.folder, projectName: project.name, machine: project.machine || null };
    const terminal = { key: 'terminal', label: 'Terminal', icon: 'terminal', color: t.foreground };
    const remembered = shared(START_AGENT_KEY) || {};
    const launcher = activeLauncher();
    if (launcher) {
      const choices = composerChoices(shared(`herdr-zed.composer.${launcher.id}`), project.machine);
      // A launcher that has not published this machine yet: its picker chooses instead.
      if (!choices) {
        this.startTarget = { picker: true, takesTask: true, project, target };
        return this.composerView(project, t, cx, { ready: true, takesTask: true, action: 'Start…',
          hint: 'chooses the program, model and effort' });
      }
      const key = remembered[startProjectKey(project)];
      const choice = key === 'terminal' ? null : choices.find(item => item.key === key) || choices[0] || null;
      const values = choice ? this.startValues(choice) : {};
      this.startTarget = choice ? { intent: { launcher: launcher.id, choice: choice.key, values }, takesTask: true, project, target }
        : { agent: null, takesTask: false, project, target };
      const options = [terminal, ...choices.map(item => ({ key: item.key, label: item.label, icon: item.icon || 'agent', iconTint: item.tint === true, color: t.foreground }))];
      const fields = (choice?.fields || []).slice(0, START_FIELDS).map((field, index) => {
        if (field.type === 'toggle') return Button(`project-start-${field.id}`, t, { variant: 'ghost' }).h(28).px(8).gap(6)
          .bg(values[field.id] ? t.selected : '#00000000').text_color(values[field.id] ? t.foreground : t.muted)
          .accessibility_label(`${field.label} ${values[field.id] ? 'on' : 'off'}`)
          .on_click((_event, cx) => this.pickStartValue(choice, field.id, !values[field.id], cx))
          .child(glyph('zap', 14)).child(field.label);
        const shown = field.options.filter(option => composerOptionShown(option, values))
          .map(option => ({ key: option.key, label: option.label, color: t.foreground }));
        return Select(`project-start-${field.id}`, this.startFieldSelects[index], values[field.id], shown, field.label,
          (value, cx) => this.pickStartValue(choice, field.id, value, cx), t, { width: 136 });
      });
      return this.composerView(project, t, cx, { ready: true, takesTask: Boolean(choice), icon: choice || null,
        controls: [Select('project-start-agent', this.startSelect, choice?.key || 'terminal', options, 'Program',
          (key, cx) => this.chooseStartAgent(project, key, cx), t, { width: 180 }), ...fields] });
    }
    const programs = this.startAgents(project.machine, cx), items = programs.items || [];
    const agent = startChoice(items, project, remembered);
    this.startTarget = { agent, takesTask: Boolean(agent), project, target };
    const options = [terminal, ...items.map(item => ({ key: item.key, label: item.name, icon: item.icon || 'agent', iconTint: item.tint, color: t.foreground }))];
    return this.composerView(project, t, cx, { ready: Boolean(programs.items), takesTask: Boolean(agent), icon: agent,
      status: !programs.items || programs.error ? programs.error || 'Looking for programs…' : null,
      controls: [Select('project-start-agent', this.startSelect, agent?.key || 'terminal', options, 'Program',
        (key, cx) => this.chooseStartAgent(project, key, cx), t, { width: 180 })] });
  },
  composerView(project, t, cx, { ready, takesTask, icon = null, controls = [], status = null, action = 'Start', hint = 'starts' }) {
    const shortcut = window()?.platform === 'macos' ? '⌘ Enter' : 'Ctrl+Enter';
    return div().id('project-start').size_full().bg(t.background).text_color(t.foreground).flex().items_center().justify_center().p(24)
      .child(v_flex().w_full().max_w(680).gap(12)
        .child(h_flex().gap(8).items_baseline().child(div().text_size(15).font_medium().child('Start a thread'))
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(project.name)))
        .child(v_flex().border(1).border_color(t.border).bg(t.popover)
          .child(Textarea.new(this.startTask).id('project-start-task').w_full().px(12).py(10).border(0).text_size(13)
            .disabled(!takesTask).accessibility_label('Task for the new thread'))
          .child(h_flex().px(8).py(6).gap(6).items_center().flex_wrap().border_t(1).border_color(t.border)
            .children(controls)
            .child(div().flex_1())
            .child(div().text_size(11).text_color(t.dim).child(takesTask ? `${shortcut} ${hint}` : 'A terminal starts without a task'))
            .child(Button('project-start-submit', t).h(28).gap(6).disabled(!ready)
              .accessibility_label(action === 'Start' ? `Start ${icon?.label || icon?.name || 'Terminal'}` : 'Choose the program and start')
              .on_click((_event, cx) => this.submitStart(cx))
              .when(action === 'Start', el => el.child(div().size(14).flex().items_center().justify_center().child(AgentIcon(icon, t))))
              .child(action))))
        .when(Boolean(status), el => el.child(div().text_size(12).text_color(t.muted).child(status))));
  },
};
