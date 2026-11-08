import { div } from 'gpui-kit';
import { h_flex } from 'gpui-base';
import { shared, setShared, home, readTextFile } from 'herdr';
import { effortLabel, claudeModels, claudeEfforts, codexHome, codexModels, isClaudeLauncher, isCodexLauncher, sessionKind, shownOptions, orderedOptions, settingsKey, launcherOption } from './model.js';
import { Select, SelectState } from './components/select.js';
import { Button } from './components/button.js';
import { glyph } from './components/icon.js';

const sessionButton = (id, t) => Button(id, t).rounded(t.appearance === 'linear' ? 999 : 6);
export class TaskSession {
  init(cx) {
    this.selects = { agent: new SelectState(cx), model: new SelectState(cx), effort: new SelectState(cx) };
    this.codexModels = new Map();
  }

  render(task, agents, start, t, cx) {
    this.cx = cx;
    try { return this.launchRow(task, agents, start, t); } finally { this.cx = null; }
  }

  // Remembers the last agent, model and effort; a model or effort the chosen agent lacks falls back to Default.
  session(agents) {
    const saved = shared('devkits.asana-session') || {};
    const agent = agents.find(agent => agent.key === saved.agent) || agents[0] || null;
    const models = this.modelsFor(agent);
    const model = models.find(item => item.key === saved.model) ? saved.model : null;
    const profile = this.profileFor(agent);
    const efforts = this.effortsFor(agent, model || profile.model);
    return { agent, models, model, efforts, effort: efforts.includes(saved.effort) ? saved.effort : null };
  }

  // Only the models and efforts Manage leaves checked are offered.
  profileFor(agent) {
    const stored = shared('devkits.profile-sessions')?.[settingsKey(agent)] || {};
    const hidden = shared('devkits.session-options')?.[sessionKind(agent)] || {};
    return { model: hidden.models?.includes(stored.model) ? null : stored.model,
      effort: hidden.efforts?.includes(stored.effort) ? null : stored.effort };
  }

  modelsFor(agent) {
    const options = shared('devkits.session-options')?.[sessionKind(agent)];
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
    const hidden = shared('devkits.session-options')?.[sessionKind(agent)]?.efforts;
    if (isClaudeLauncher(agent)) return shownOptions(claudeEfforts, hidden);
    if (!isCodexLauncher(agent)) return [];
    const models = model ? this.allModels(agent) : this.modelsFor(agent);
    const levels = model ? models.find(item => item.key === model)?.efforts || [] : models.flatMap(item => item.efforts);
    return shownOptions([...new Set(levels)], hidden);
  }

  launchRow(task, agents, start, t) {
    const current = this.session(agents);
    const remember = change => setShared('devkits.asana-session', { ...(shared('devkits.asana-session') || {}), ...change });
    const option = (key, label) => ({ key, label, color: key === 'default' ? t.muted : t.foreground });
    // Default is the agent profile's own model and effort from Manage, named when it has one.
    const profile = this.profileFor(current.agent);
    const defaultEffort = this.effortsFor(current.agent, current.model || profile.model).includes(profile.effort) ? profile.effort : null;
    const fallback = { model: profile.model && (this.allModels(current.agent).find(item => item.key === profile.model)?.label || profile.model),
      effort: defaultEffort && effortLabel(defaultEffort) };
    const pick = (id, name, label, value, options, onChange) => Select(id, this.selects[name], value || 'default',
      [option('default', fallback[name] ? `Default (${fallback[name]})` : 'Default'), ...options], label, onChange, t, { width: 168, prefix: label, boxed: t.appearance !== 'linear', radius: 6 });
    return h_flex().gap(8).items_center().flex_wrap()
      .when(agents.length > 0, el => el.child(Select('task-session-agent', this.selects.agent, current.agent.key,
        agents.map(agent => ({ ...launcherOption(agent), color: t.foreground })), 'Agent',
        key => remember({ agent: key, model: null, effort: null }), t, { width: 200, prefix: 'Agent', boxed: t.appearance !== 'linear', radius: 6 })))
      .when(current.models.length > 0, el => el.child(pick('task-session-model', 'model', 'Model', current.model,
        current.models.map(model => option(model.key, model.label)), key => remember({ model: key === 'default' ? null : key }))))
      .when(current.efforts.length > 0, el => el.child(pick('task-session-effort', 'effort', 'Effort', current.effort,
        current.efforts.map(effort => option(effort, effortLabel(effort))), key => remember({ effort: key === 'default' ? null : key }))))
      .child(div().flex_1())
      .child(sessionButton('task-session-start', t).h(28).px(10).gap(6).disabled(!current.agent).accessibility_label('Start a session for this task')
        .on_click((_event, cx) => { if (current.agent) start(current.agent, task, {
          model: current.model || profile.model || null,
          effort: current.effort || defaultEffort,
        }, cx); })
        .child(glyph('plus', 12)).child('Start session'));
  }

}
