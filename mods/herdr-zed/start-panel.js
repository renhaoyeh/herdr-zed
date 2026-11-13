import { div } from 'gpui-kit';
import { v_flex, h_flex, TextareaState, Textarea, Popup } from 'gpui-base';
import { shared, setShared, spaces, exec, notify } from 'herdr';
import { pasteClipboardImage, withAttachments, AttachmentStrip } from './components/image-attachments.js';
import { Button, ToolbarButton } from './components/button.js';
import { DropdownMenuContent } from './components/dropdown-menu.js';
import { Empty, EmptyTitle, EmptyDescription } from './components/empty.js';
import { glyph, AgentIcon } from './components/icon.js';
import { activeLauncher } from './extensions.js';
import { composerChoices, composerUsage, composerOptionShown, launchIntent } from './components/extension-contract.js';
import { Progress } from './components/progress.js';
import { quotaElapsedPercent, quotaResetLabel } from './components/session-model.js';

// The program chosen last in each project, so the composer opens on it.
export const START_AGENT_KEY = 'herdr-zed.start-agent';
// New thread's request to the editor view: the project (startProjectKey) whose New thread tab to open.
export const COMPOSE_KEY = 'herdr-zed.compose';
// ARCHITECTURE §3.1 Composer: shell -> launcher. The shell only appends; the launcher takes its own intents off.
export const LAUNCH_INTENTS = 'herdr-zed.launch.intents';
// Starred options: { [launcher or '']: { [menu]: [option keys] } }, listed first in that control's menu.
export const START_FAVORITES_KEY = 'herdr-zed.start-favorites';
// The program control and at most this many minus one launcher fields.
const START_MENUS = 7;
// How long Start waits for the new thread's tab before it gives the task back to edit.
export const START_WAIT_MS = 30000;
// `git status --porcelain=v1 -b`: the branch line, then one line per changed path.
export function parseGitStatus(stdout) {
  const [head = '', ...rest] = String(stdout || '').split(/\r?\n/);
  const branch = head.startsWith('## ') ? head.slice(3).replace(/\.\.\..*$/, '').replace(/^No commits yet on /, '').trim() : null;
  const ahead = Number(/ahead (\d+)/.exec(head)?.[1] || 0), behind = Number(/behind (\d+)/.exec(head)?.[1] || 0);
  return { branch, changes: rest.filter(line => line.trim()).length, ahead, behind };
}
const GIT_REFRESH_MS = 5000;
const tabIds = () => new Set(spaces().flatMap(space => (space.tabs || []).map(tab => tab.id)));
export const startProjectKey = project => JSON.stringify([project.machine || '', (project.folder || '').replace(/\\/g, '/').replace(/\/+$/, '') || project.id]);
export function startChoice(programs, project, remembered = {}) {
  const key = remembered[startProjectKey(project)];
  return programs.find(agent => agent.key === key) || programs[0] || null;
}

// Start a thread: describe the task, pick the program and its session fields, then Ctrl+Enter (Cmd+Enter on macOS) or
// Start. Plain Enter adds a line; nothing is sent by accident. The text becomes the agent's first message; a Terminal
// starts empty. With a launcher extension, the programs and their fields (model, effort, Fast...) are the ones it
// publishes, and Start hands it a launch intent (ARCHITECTURE §3.1 Composer); without one, native programs start as is.
export const startPanel = {
  initStartPanel(cx) {
    this.startTask = TextareaState.new({ placeholder: 'What would you like to do?' });
    this.startTask.set_auto_grow(4, 12);
    this.startTask.on('change', (_event, cx) => cx.notify());
    this.startTask.on('submit', (event, cx) => {
      const modified = shared('herdr-zed.ctrl-enter-submit') !== false;
      if (!event?.shift && Boolean(event?.secondary) === modified) this.submitStart(cx);
    });
    // A pasted image is saved and shown under the task; its path goes to the agent with the task.
    this.startImages = [];
    this.startTask.on('paste_other', (_event, cx) => cx.spawn(async cx => {
      try { const item = await pasteClipboardImage(); if (item) this.startImages = [...this.startImages, item]; }
      catch (error) { notify({ title: 'Could not paste the image', body: error.message, level: 'error' }); }
      cx.notify();
    }));
    // Each control menu's focus handle exists before render (a handle made while drawing is dropped next frame).
    this.startMenuFocus = Array.from({ length: START_MENUS }, () => cx.focus_handle?.());
    // Shared state does not repaint this view: redraw when the launcher republishes its composer choices.
    cx.timer?.every(500, cx => {
      const launcher = activeLauncher(), seen = launcher ? shared(`herdr-zed.composer.${launcher.id}`)?.updatedAt ?? null : null;
      if (seen !== this.startSeen) { this.startSeen = seen; cx.notify(); }
      this.settleStart(cx);
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
    if (!start || !start.takesTask || this.startPending) return;
    const task = start.takesTask ? withAttachments(this.startTask.value().trim(), this.startImages) : '';
    this.startPending = { known: tabIds(), target: start.target, editorKey: this.editor?.projectKey, until: Date.now() + START_WAIT_MS };
    if (start.intent) {
      // ARCHITECTURE §3.1 Composer: the launcher prepares the account and emits the launch request.
      setShared(LAUNCH_INTENTS, [...(shared(LAUNCH_INTENTS) || []).filter(intent => intent?.expiresAt > Date.now()),
        launchIntent({ ...start.intent, target: start.target, ...(task ? { task } : {}), now: Date.now() })]);
    } else if (start.picker) this.openLauncher(start.project, task || null);
    else this.startThread(start.agent, { ...start.target, ...(task ? { task } : {}) });
    // The panel stays. Its task is kept until the new thread's tab appears, so a launch that fails loses nothing.
    cx.notify();
  },
  // Observe the new thread in the launch's project before closing its draft; timeout preserves the task.
  settleStart(cx, now = Date.now()) {
    const pending = this.startPending;
    if (!pending) return;
    const project = spaces().find(space => (pending.target.space ? space.id === pending.target.space
      : startProjectKey(space) === startProjectKey({ ...pending.target, id: pending.target.space }))
      && (space.machine || '') === (pending.target.machine || ''));
    const thread = project?.tabs?.find(tab => !pending.known.has(tab.id));
    if (thread) {
      this.startTask.set_value(''); this.startImages = [];
      this.editor?.finishCompose(pending.editorKey, cx);
      if (project.active) this.showConversation?.(true, { ...project, tabs: [{ ...thread, active: true }] });
    } else if (now < pending.until) return;
    this.startPending = null;
    cx.notify();
  },
  // The values of one launcher choice: its fields' published defaults, then what was picked here. A select whose value
  // the other picks no longer allow falls back to its first offered option.
  startValues(choice, picked = (shared('herdr-zed.start-values') || {})[choice.key] || {}) {
    const values = {};
    for (const field of choice.fields) values[field.id] = field.id in picked ? picked[field.id] : field.value;
    for (const field of choice.fields) {
      if (field.type !== 'select') continue;
      const shown = field.options.filter(option => composerOptionShown(option, values));
      if (!shown.some(option => option.key === values[field.id])) values[field.id] = shown[0]?.key ?? field.value;
    }
    return values;
  },
  pickStartValue(choice, id, value, cx) {
    const all = shared('herdr-zed.start-values') || {};
    setShared('herdr-zed.start-values', { ...all, [choice.key]: this.startValues(choice, { ...this.startValues(choice), [id]: value }) });
    cx.notify();
  },
  // The project's Git state for the panel header, read at most every 5 s while the panel is drawn.
  startGit(project, cx) {
    this.startGitState ||= new Map();
    const key = startProjectKey(project), entry = this.startGitState.get(key) || { value: null, at: 0, loading: false };
    this.startGitState.set(key, entry);
    if (!entry.loading && Date.now() - entry.at > GIT_REFRESH_MS && project.folder) {
      entry.loading = true;
      cx.spawn(async cx => {
        try {
          const result = await exec('git', ['-C', project.folder, 'status', '--porcelain=v1', '-b'], { on: project.machine || null, timeout: 5000 });
          entry.value = result.code === 0 ? parseGitStatus(result.stdout) : null;
        } catch { entry.value = null; }
        entry.at = Date.now(); entry.loading = false;
        cx.notify();
      });
    }
    return entry.value;
  },
  startGitView(project, t, cx) {
    const git = this.startGit(project, cx);
    if (!git?.branch) return null;
    return h_flex().gap(4).items_center().text_size(12).text_color(t.muted)
      .child(glyph('branch', 12)).child(div().min_w(0).max_w(220).truncate().child(git.branch));
  },

  // The session the panel starts: a program (or Terminal) and, with a launcher, its field values. `session.choices`
  // are every program the menu offers.
  startSession(project, cx) {
    const remembered = shared(START_AGENT_KEY) || {}, key = remembered[startProjectKey(project)];
    const launcher = activeLauncher();
    if (launcher) {
      const choices = composerChoices(shared(`herdr-zed.composer.${launcher.id}`), project.machine);
      // A launcher that has not published this machine yet: its picker chooses instead.
      if (!choices) return { launcher: launcher.id, picker: true };
      const choice = choices.find(item => item.key === key) || choices[0] || null;
      return { launcher: launcher.id, choices, usage: composerUsage(shared(`herdr-zed.composer.${launcher.id}`), project.machine), choice, values: choice ? this.startValues(choice) : {}, ready: true };
    }
    const programs = this.startAgents(project.machine, cx), items = programs.items || [];
    const agent = startChoice(items, project, remembered);
    const choices = items.map(item => ({ key: item.key, label: item.name, icon: item.icon, tint: item.tint, fields: [], agent: item }));
    return { launcher: '', choices, choice: agent ? choices.find(item => item.key === agent.key) : null, values: {}, agent,
      ready: Boolean(programs.items), status: !programs.items || programs.error ? programs.error || 'Looking for programs…' : null };
  },
  // Favorites (like Zed's starred models): per menu, the starred option keys, listed first in that menu. A menu is the
  // program list ('program') or one launcher field ('<choice>:<field>'); keys are kept per launcher.
  startFavorites(launcher, menu) { return (shared(START_FAVORITES_KEY) || {})[launcher || '']?.[menu] || []; },
  toggleStartFavorite(launcher, menu, key, cx) {
    const all = shared(START_FAVORITES_KEY) || {}, mine = all[launcher || ''] || {}, current = mine[menu] || [];
    const next = current.includes(key) ? current.filter(item => item !== key) : [...current, key];
    setShared(START_FAVORITES_KEY, { ...all, [launcher || '']: { ...mine, [menu]: next } });
    cx.notify();
  },
  closeStartMenu(cx) { this.startMenuOpen = null; cx.notify(); },
  // One control's menu: starred options first, a star on every row, the current one checked.
  startMenu(id, index, { launcher, menu, label, items, value, choose }, t) {
    const starred = this.startFavorites(launcher, menu).filter(key => items.some(item => item.key === key));
    const ordered = [...starred.map(key => items.find(item => item.key === key)), ...items.filter(item => !starred.includes(item.key))];
    const row = (item, i) => h_flex().id(`${id}-item-${item.key}`).h(30).pl(10).pr(4).gap(8).items_center().cursor_pointer()
      .bg(item.key === value ? t.selected : t.popover).hover(el => el.bg(t.hover)).accessibility_label(`${item.label}${item.key === value ? ', selected' : ''}`)
      .on_click((_event, cx) => { cx.stop_propagation(); choose(item.key, cx); this.closeStartMenu(cx); })
      .when(Boolean(item.icon), el => el.child(item.icon))
      .child(div().flex_1().min_w(0).truncate().text_size(13).child(item.label))
      .child(Button(`${id}-star-${item.key}`, t, { variant: 'ghost', size: 'icon-sm' })
        .accessibility_label(starred.includes(item.key) ? `Unstar ${item.label}` : `Star ${item.label}`)
        .on_click((_event, cx) => { cx.stop_propagation(); this.toggleStartFavorite(launcher, menu, item.key, cx); })
        .child(glyph(starred.includes(item.key) ? 'star-filled' : 'star', 13).text_color(starred.includes(item.key) ? t.working : t.dim)))
      .when(i === starred.length - 1 && starred.length < ordered.length, el => el.border_b(1).border_color(t.border));
    return DropdownMenuContent(`${id}-menu`, undefined, t).min_w(220).max_w(380).mt(4).py(4)
      .track_focus(this.startMenuFocus[index]).on_mouse_down_out((_event, cx) => this.closeStartMenu(cx))
      .on_key_down((event, cx) => { if (event.key === 'escape') { cx.stop_propagation(); this.closeStartMenu(cx); } })
      .child(div().px(10).pt(4).pb(4).text_size(11).font_medium().text_color(t.muted).child(label.toUpperCase()))
      .children(ordered.map(row));
  },
  // A control button and its menu (design.md, Start a thread).
  startControl(id, index, trigger, menu, t) {
    const open = this.startMenuOpen === id;
    const button = Button(id, t, { variant: 'ghost' }).h(28).px(8).gap(6).max_w(260).bg(open ? t.selected : '#00000000')
      .text_color(t.foreground).accessibility_label(trigger.label)
      .on_click((_event, cx) => { cx.stop_propagation(); this.startMenuOpen = open ? null : id; if (!open) this.startMenuFocus[index]?.focus(); cx.notify(); })
      .when(Boolean(trigger.icon), el => el.child(trigger.icon))
      .child(div().min_w(0).truncate().text_size(12).child(trigger.text))
      .child(glyph('chevron-down', 12).text_color(t.muted));
    return Popup.new(`${id}-popup`, button).anchor('top_left').when(open, el => el.content(this.startMenu(id, index, menu, t)));
  },
  // The session controls, split like Zed's: the program, then one control per launcher field (a select is a menu, a
  // toggle is an icon button). All session controls stay in the input toolbar.
  startSessionControls(project, session, t) {
    const { choice, values, launcher } = session;
    const icon = item => div().size(14).flex_none().flex().items_center().justify_center()
      .child(item ? AgentIcon({ icon: item.icon, tint: item.tint }, t).size(14) : glyph('terminal', 14).text_color(t.muted));
    const programs = session.choices.map(item => ({ key: item.key, label: item.label, icon: icon(item) }));
    const controls = [this.startControl('project-start-program', 0, { icon: icon(choice), text: choice?.label || 'No agents available', label: `Program: ${choice?.label || 'No agents available'}` },
      { launcher, menu: 'program', label: 'Program', items: programs, value: choice?.key || 'terminal',
        choose: (key, cx) => this.chooseStartAgent(project, key, cx) }, t)];
    (choice?.fields || []).slice(0, START_MENUS - 1).forEach((field, i) => {
      if (field.type === 'toggle') {
        const on = values[field.id] === true;
        controls.push(ToolbarButton(`project-start-${field.id}`, t, { icon: true, selected: on })
          .tooltip(`${field.label} ${on ? 'on' : 'off'}`).accessibility_label(`${field.label} ${on ? 'on' : 'off'}`)
          .on_click((_event, cx) => this.pickStartValue(choice, field.id, !on, cx))
          .child(glyph('zap', 16).text_color(on ? t.working : t.muted)));
        return;
      }
      const shown = field.options.filter(option => composerOptionShown(option, values))
        .map(option => ({ key: option.key, label: option.label }));
      const current = shown.find(option => option.key === values[field.id]);
      controls.push(this.startControl(`project-start-${field.id}`, i + 1,
        { text: current?.label || field.label, label: `${field.label}: ${current?.label || field.label}` },
        { launcher, menu: `${choice.key}:${field.id}`, label: field.label, items: shown, value: values[field.id],
          choose: (key, cx) => this.pickStartValue(choice, field.id, key, cx) }, t));
    });
    return { controls, usage: this.startUsageView(project, session, t) };
  },
  // Every account's quota below the composer, side by side, drawn like the Usage sidebar's meters (design.md, Start a thread).
  // A card starts its account's first program in the menu; an account the menu does not offer stays inert.
  startUsageView(project, session, t) {
    const accounts = session.usage || [];
    if (!accounts.length) return null;
    const current = session.choice?.key.split('#')[0];
    // Equal cards: a fixed number of columns, the last row padded, and one line per window any account has.
    const columns = Math.min(3, accounts.length);
    const slots = [...new Map(accounts.flatMap(account => account.windows).map(window => [window.minutes, window])).values()]
      .sort((a, b) => a.minutes - b.minutes);
    const line = (account, slot) => {
      const window = account.windows.find(item => item.minutes === slot.minutes);
      const row = h_flex().w_full().h(12).gap(4).items_center().text_size(10).whitespace_nowrap().text_color(t.muted)
        .child(div().w(30).flex_none().child(slot.label));
      if (!window) return row.child(div().flex_1().child('—'));
      const elapsed = quotaElapsedPercent(window), reset = quotaResetLabel(window);
      const time = reset === 'Reset time unavailable' ? '—' : reset.startsWith('Reset due') ? 'Reset due' : reset.replace(/^Resets (?:in )?/, '');
      return row
        .child(Progress(`project-start-usage-${account.key}-${window.minutes}`, window.usedPercent, t, elapsed, window.minutes === 300 ? 5 : window.minutes === 10080 ? 7 : 0)
          .flex_1().w_auto().min_w(0).accessibility_label(`${account.label} ${window.label} used`))
        .child(div().w(28).flex_none().font_family('Geist Mono').text_right().child(`${Math.round(window.usedPercent)}%`))
        .child(div().w(54).flex_none().font_family('Geist Mono').text_right().accessibility_label(reset).child(time.replace(/\b(\d)([dhm])\b/g, '0$1$2')));
    };
    const program = account => (session.choices || []).find(item => item.key.split('#')[0] === account.key);
    const card = account => v_flex().id(`project-start-usage-${account.key}`).w_full().min_w(0).gap(4).px(10).py(6).border(1)
      .border_color(account.key === current ? t.accent : t.border)
      .when(Boolean(program(account)) && account.key !== current, el => el.cursor_pointer().hover(el => el.bg(t.hover))
        .accessibility_label(`Use ${program(account).label}`)
        .on_click((_event, cx) => this.chooseStartAgent(project, program(account).key, cx)))
      .child(h_flex().h(14).gap(6).items_center()
        .child(AgentIcon({ icon: account.icon, tint: account.tint }, t).size(12))
        .child(div().min_w(0).truncate().text_size(12).font_semibold().text_color(account.muted ? t.muted : t.foreground).child(account.label)))
      .children(slots.map(slot => line(account, slot)));
    const rows = Array.from({ length: Math.ceil(accounts.length / columns) }, (_, i) => accounts.slice(i * columns, i * columns + columns));
    return v_flex().id('project-start-usage').w_full().gap(8).children(rows.map((row, i) =>
      // Identical outer cells own sizing; card padding and borders must not affect column widths.
      h_flex().id(`project-start-usage-row-${i}`).w_full().gap(8).children(
        Array.from({ length: columns }, (_, j) => div().id(`project-start-usage-cell-${i}-${j}`)
          .flex_1().flex_basis(0).min_w(0).when(Boolean(row[j]), el => el.child(card(row[j])))))));
  },
  projectStartView(project, t, cx) {
    if (!project) return div().size_full().bg(t.background);
    const target = { space: project.pending ? null : project.id, folder: project.folder, projectName: project.name, machine: project.machine || null };
    const session = this.startSession(project, cx);
    if (session.picker) {
      this.startTarget = { picker: true, takesTask: true, project, target };
      return this.composerView(project, t, cx, { ready: true, takesTask: true, action: 'Choose the program and start' });
    }
    const { choice, values } = session;
    this.startTarget = session.launcher
      ? choice ? { intent: { launcher: session.launcher, choice: choice.key, values }, takesTask: true, project, target } : { agent: null, takesTask: false, project, target }
      : { agent: session.agent || null, takesTask: Boolean(session.agent), project, target };
    return this.composerView(project, t, cx, { ready: session.ready && Boolean(choice), takesTask: Boolean(choice), status: session.status || null,
      session: this.startSessionControls(project, session, t) });
  },
  composerView(project, t, cx, { ready, takesTask, session = { controls: [] }, status = null, action = 'Start task' }) {
    const git = this.startGitView(project, t, cx);
    return v_flex().id('project-start').size_full().bg(t.background).text_color(t.foreground).items_center().p(24).overflow_y_scroll()
      .child(div().flex_1().min_h(0))
      .child(v_flex().w_full().max_w(680).flex_none().gap(10)
        .child(h_flex().id('project-start-heading').gap(8).items_center()
          .child(div().flex_none().text_size(15).font_medium().child('New thread'))
          .child(div().flex_1())
          .child(h_flex().min_w(0).gap(8).items_center().text_size(12).text_color(t.muted)
            .child(div().min_w(0).truncate().tooltip(project.name).child(project.name))
            .when(Boolean(git), el => el.child(git))))
        .child(v_flex().border(1).border_color(t.border).bg(t.popover)
          .child(Textarea.new(this.startTask).id('project-start-task').w_full().px(12).py(10).border(0).text_size(13)
            .disabled(!takesTask || Boolean(this.startPending)).accessibility_label('Task for the new thread'))
          .when(takesTask && this.startImages.length > 0, el => el.child(div().px(12).pb(8).child(AttachmentStrip('project-start-images', this.startImages,
            (index, cx) => { this.startImages = this.startImages.filter((_item, at) => at !== index); cx.notify(); }, t, 'herdr-zed'))))
          .child(h_flex().id('project-start-toolbar').px(8).py(6).gap(8).items_center().border_t(1).border_color(t.border)
            .flex_wrap().children(session.controls).child(div().flex_1())
            .children(this.composerActions?.(project, t) || [])
            .child(ToolbarButton('project-start-submit', t, { icon: true }).disabled(!ready || Boolean(this.startPending))
              .tooltip(this.startPending ? 'Starting…' : action).accessibility_label(this.startPending ? 'Starting…' : action)
              .on_click((_event, cx) => this.submitStart(cx))
              .child(glyph(this.startPending ? 'loader' : 'arrow-up', 16)))))
        .when(Boolean(session.usage), el => el.child(session.usage))
        .when(Boolean(status), el => el.child(div().text_size(12).text_color(t.muted).child(status))))
      .child(div().flex_1().min_h(0));
  },
};
