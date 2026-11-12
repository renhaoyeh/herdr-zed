import { div } from 'gpui-kit';
import { h_flex, v_flex, TextareaState, Textarea } from 'gpui-base';
import { shared, setShared, home, readTextFile } from 'herdr';
import { effortLabel, claudeModels, claudeEfforts, codexHome, codexModels, isClaudeLauncher, isCodexLauncher, sessionKind, shownOptions, orderedOptions, settingsKey, launcherOption, accountAddresses } from './components/session-model.js';
import { Select, SelectState } from './components/select.js';
import { Button } from './components/button.js';
import { glyph } from './components/icon.js';
import { continuationPrompt } from './task-prompt.js';

const sessionButton = (id, t) => Button(id, t).rounded(t.appearance === 'linear' ? 999 : 6);
export class TaskSession {
  init(cx) {
    this.selects = { agent: new SelectState(cx), model: new SelectState(cx), effort: new SelectState(cx) };
    this.codexModels = new Map();
    // One editor for the shown task (state cannot be created during render); `prompt` records which task it holds.
    this.promptState = TextareaState.new({ placeholder: 'Extra instructions for the agent (optional)…' });
    this.promptState.set_auto_grow(4, 14);
    this.prompt = null;
  }

  // The editable instructions for the next session of a task, prefilled with the Continue prompt once it has earlier
  // sessions. Another task, or a new session result the person has not edited over, resets it to the default.
  promptFor(task) {
    const base = continuationPrompt(task) || '';
    const current = this.prompt;
    if (current?.gid !== task.gid || (current.base !== base && this.promptState.value() === current.base)) {
      this.promptState.set_value(base);
      this.prompt = { gid: task.gid, base };
    }
    return { state: this.promptState };
  }

  render(task, agents, start, t, cx) {
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
    return { agent, models, model, efforts, effort: efforts.includes(saved.effort) ? saved.effort : null };
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
      [option('default', fallback[name] ? `Default (${fallback[name]})` : 'Default'), ...options], label, onChange, t, { width: 168, prefix: label, boxed: t.appearance !== 'linear', radius: 6 });
    const prompt = this.promptFor(task);
    return v_flex().gap(8)
      .child(div().text_size(12).font_medium().child(resume ? 'Continue with' : 'Instructions'))
      .child(Textarea.new(prompt.state).id('task-session-prompt').accessibility_label(resume ? 'Prompt for the next session' : 'Extra instructions')
        .w_full().text_size(12))
      .child(h_flex().gap(8).items_center().flex_wrap()
      .when(agents.length > 0, el => el.child(Select('task-session-agent', this.selects.agent, current.agent.key,
        agents.map(agent => launcherOption(agent, accountAddresses(shared))).map(option => ({ ...option, color: option.unknown ? t.muted : t.foreground })), 'Agent',
        key => remember({ agent: key, model: null, effort: null }), t, { width: 200, prefix: 'Agent', boxed: t.appearance !== 'linear', radius: 6 })))
      .when(current.models.length > 0, el => el.child(pick('task-session-model', 'model', 'Model', current.model,
        current.models.map(model => option(model.key, model.label)), key => remember({ model: key === 'default' ? null : key }))))
      .when(current.efforts.length > 0, el => el.child(pick('task-session-effort', 'effort', 'Effort', current.effort,
        current.efforts.map(effort => option(effort, effortLabel(effort))), key => remember({ effort: key === 'default' ? null : key }))))
      .child(div().flex_1())
      .child(sessionButton('task-session-start', t).h(28).px(10).gap(6).disabled(!current.agent)
        .accessibility_label(resume ? 'Continue this task in a new session' : 'Start a session for this task')
        .on_click((_event, cx) => { if (current.agent) start(current.agent, task, {
          model: current.model || profile.model || null,
          effort: current.effort || defaultEffort,
          instructions: prompt.state.value(),
        }, cx); this.prompt = null; })
        .child(glyph(resume ? 'play' : 'plus', 12)).child(resume ? 'Continue' : 'Start session')));
  }

}
