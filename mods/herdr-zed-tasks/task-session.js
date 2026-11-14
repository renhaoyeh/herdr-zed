import { div } from 'gpui-kit';
import { h_flex, v_flex, TextareaState, Textarea } from 'gpui-base';
import { shared, setShared, home, readTextFile, notify } from 'herdr';
import { effortLabel, claudeModels, claudeEfforts, codexHome, codexModels, isClaudeLauncher, isCodexLauncher, sessionKind, shownOptions, orderedOptions, settingsKey, launcherOption, accountAddresses } from './components/session-model.js';
import { agentWorkflowFields, launchWorkflowOptions } from './components/agent-launch-options.js';
import { workflowExecutor } from './components/agent-workflows.js';
import { Select, SelectState } from './components/select.js';
import { ToolbarButton } from './components/button.js';
import { glyph } from './components/icon.js';
import { continuationPrompt } from './task-prompt.js';
import { pasteClipboardImage, withAttachments, AttachmentStrip } from './components/image-attachments.js';

export class TaskSession {
  init(cx) {
    this.selects = Object.fromEntries(['agent', 'model', 'effort', 'workflow', 'eccProfile'].map(name => [name, new SelectState(cx)]));
    this.codexModels = new Map();
    // One editor for the shown task (state cannot be created during render); `prompt` records which task it holds.
    this.promptState = TextareaState.new({ placeholder: 'Extra instructions for the agent (optional)…' });
    this.promptState.set_auto_grow(4, 14);
    this.images = [];
    this.promptState.on('paste_other', (_event, cx) => cx.spawn(async cx => {
      try { const item = await pasteClipboardImage(); if (item) this.images = [...this.images, item]; }
      catch (error) { notify({ title: 'Could not paste the image', body: error.message, level: 'error' }); }
      cx.notify();
    }));
    this.prompt = null;
  }

  // The editable instructions for the next session of a task, prefilled with the Continue prompt once it has earlier
  // sessions. Another task, or a new session result the person has not edited over, resets it to the default.
  promptFor(task) {
    const base = continuationPrompt(task) || '';
    const current = this.prompt;
    if (current?.gid !== task.gid || (current.base !== base && this.promptState.value() === current.base)) {
      this.promptState.set_value(base);
      if (current?.gid !== task.gid) this.images = [];
      this.prompt = { gid: task.gid, base };
    }
    return { state: this.promptState };
  }

  render(task, agents, start, t, cx, project = {}) {
    this.machine = project.machine || null;
    this.cx = cx;
    try { return this.launchRow(task, agents, start, t); } finally { this.cx = null; }
  }

  // Remembers the last agent, model and effort; a model or effort the chosen agent lacks falls back to Default.
  session(agents) {
    const saved = shared('herdr-zed.asana-session') || {};
    const agent = agents.find(agent => agent.key === saved.agent) || agents[0] || null;
    const models = this.modelsFor(agent);
    const model = models.find(item => item.key === saved.model) ? saved.model : null;
    const profile = this.profileFor(agent);
    const efforts = this.effortsFor(agent, model || profile.model);
    const fields = agentWorkflowFields(agent, shared('herdr-zed.profile-sessions')?.[settingsKey(agent)] || {},
      { local: !this.machine, executor: workflowExecutor('supervisor') });
    const values = Object.fromEntries(fields.map(field => [field.id, field.value]));
    return { agent, models, model, efforts, effort: efforts.includes(saved.effort) ? saved.effort : null,
      fields, values, workflow: values.workflow || 'direct' };
  }

  // Only the models and efforts Manage leaves checked are offered.
  profileFor(agent) {
    const stored = shared('herdr-zed.profile-sessions')?.[settingsKey(agent)] || {};
    const hidden = shared('herdr-zed.session-options')?.[sessionKind(agent)] || {};
    return { model: hidden.models?.includes(stored.model) ? null : stored.model,
      effort: hidden.efforts?.includes(stored.effort) ? null : stored.effort };
  }

  modelsFor(agent) {
    const options = shared('herdr-zed.session-options')?.[sessionKind(agent)];
    return shownOptions(orderedOptions(this.allModels(agent), options?.order), options?.models);
  }

  allModels(agent) {
    if (isClaudeLauncher(agent)) return claudeModels;
    if (!isCodexLauncher(agent)) return [];
    const dir = codexHome(agent, home());
    if (!this.codexModels.has(dir)) {
      this.codexModels.set(dir, []);
      this.cx?.spawn(async cx => { this.codexModels.set(dir, codexModels(await readTextFile(`${dir}/models_cache.json`) || '')); cx.notify(); });
    }
    return this.codexModels.get(dir);
  }

  effortsFor(agent, model) {
    const hidden = shared('herdr-zed.session-options')?.[sessionKind(agent)]?.efforts;
    if (isClaudeLauncher(agent)) return shownOptions(claudeEfforts, hidden);
    if (!isCodexLauncher(agent)) return [];
    const models = model ? this.allModels(agent) : this.modelsFor(agent);
    const levels = model ? models.find(item => item.key === model)?.efforts || [] : models.flatMap(item => item.efforts);
    return shownOptions([...new Set(levels)], hidden);
  }

  launchRow(task, agents, start, t) {
    const current = this.session(agents);
    // A task with earlier sessions continues: the new session gets their results and picks up from the current state.
    const resume = Boolean(task.execution || task.runs?.length);
    const remember = change => setShared('herdr-zed.asana-session', { ...(shared('herdr-zed.asana-session') || {}), ...change });
    const option = (key, label) => ({ key, label, color: key === 'default' ? t.muted : t.foreground });
    // Default is the agent profile's own model and effort from Manage, named when it has one.
    const profile = this.profileFor(current.agent);
    const defaultEffort = this.effortsFor(current.agent, current.model || profile.model).includes(profile.effort) ? profile.effort : null;
    const fallback = { model: profile.model && (this.allModels(current.agent).find(item => item.key === profile.model)?.label || profile.model),
      effort: defaultEffort && effortLabel(defaultEffort) };
    const pick = (id, name, label, value, options, onChange) => Select(id, this.selects[name], value || 'default',
      [option('default', fallback[name] ? `Default (${fallback[name]})` : 'Default'), ...options], label, onChange, t, { width: 180, toolbar: true });
    const prompt = this.promptFor(task);
    return v_flex().gap(8)
      .child(div().text_size(12).font_medium().child(resume ? 'Continue with' : 'Instructions'))
      .child(v_flex().id('task-session-composer').w_full().min_w(0).border(1).border_color(t.border).bg(t.popover)
      .child(Textarea.new(prompt.state).id('task-session-prompt').accessibility_label(resume ? 'Prompt for the next session' : 'Extra instructions')
        .w_full().px(12).py(10).border(0).text_size(13))
      .when(this.images.length > 0, el => el.child(AttachmentStrip('task-session-images', this.images,
        (index, cx) => { this.images = this.images.filter((_item, at) => at !== index); cx.notify(); }, t, 'herdr-zed-tasks')))
      .child(h_flex().id('task-session-primary-row').w_full().px(8).py(6).gap(8).items_center().border_t(1).border_color(t.border)
      .child(h_flex().id('task-session-controls').flex_1().min_w(0).gap(4).items_center().flex_wrap()
      .when(agents.length > 0, el => el.child(Select('task-session-agent', this.selects.agent, current.agent.key,
        agents.map(agent => launcherOption(agent, accountAddresses(shared))).map(option => ({ ...option, color: option.unknown ? t.muted : t.foreground })), 'Agent',
        key => remember({ agent: key, model: null, effort: null }), t, { width: 200, toolbar: true })))
      .when(current.models.length > 0, el => el.child(pick('task-session-model', 'model', 'Model', current.model,
        current.models.map(model => option(model.key, model.label)), key => remember({ model: key === 'default' ? null : key }))))
      .when(current.efforts.length > 0, el => el.child(pick('task-session-effort', 'effort', 'Effort', current.effort,
        current.efforts.map(effort => option(effort, effortLabel(effort))), key => remember({ effort: key === 'default' ? null : key })))))
      .child(ToolbarButton('task-session-start', t, { icon: true }).disabled(!current.agent)
        .tooltip(resume ? 'Continue task' : 'Start session')
        .accessibility_label(resume ? 'Continue this task in a new session' : 'Start a session for this task')
        .on_click((_event, cx) => { if (current.agent) start(current.agent, task, {
          model: current.model || profile.model || null,
          effort: current.effort || defaultEffort,
          instructions: withAttachments(prompt.state.value(), this.images),
          ...launchWorkflowOptions(current.values),
        }, cx); this.prompt = null; this.images = []; })
        .child(glyph('arrow-up', 16))))
      .when(current.fields.length > 0, el => el.child(h_flex().id('task-session-workflow-row').px(8).pb(6).gap(8).items_center().flex_wrap()
      .children(current.fields.map(field => Select(`task-session-${field.id}`, this.selects[field.id], field.value,
        field.options.map(item => option(item.key, item.label)), field.label, value => {
          const key = settingsKey(current.agent), sessions = shared('herdr-zed.profile-sessions') || {};
          setShared('herdr-zed.profile-sessions', { ...sessions, [key]: { ...sessions[key], [field.id]: value } });
        }, t, { width: 220, toolbar: true }))))))
      .when(current.workflow === 'supervisor', el => el.child(div().text_size(11).text_color(t.muted)
        .child('Research → Implementation → Review · research and review are read only.')));
  }

}
