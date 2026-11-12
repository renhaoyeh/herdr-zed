// The shell's composer (ARCHITECTURE §3.1, Composer): this service publishes the programs and their session fields
// (model, effort, Fast) per machine, and takes the composer's launch intents, preparing each like the picker does.
import { shared, setShared, home, readTextFile, notify } from 'herdr';
import { availableAgents, discoverAgents } from './discovery.js';
import { launcherChoices, launcherLabel, isAccountLauncher, sessionKind, settingsKey, sessionChoices, effortLabel, codexHome, codexModels } from './components/session-model.js';
import { emitLaunch, LAUNCHER_ID } from './launch.js';

export const COMPOSER_KEY = `herdr-zed.composer.${LAUNCHER_ID}`;
export const LAUNCH_INTENTS = 'herdr-zed.launch.intents';
const DEFAULT = 'default';
// Saved profiles share their account's key, so a choice adds the profile key.
export const choiceKey = agent => agent.profileKey ? `${agent.key}#${agent.profileKey}` : agent.key;

// The account's quota as a short reading: each window's used share, warning from 70% and error from 90% (the Usage meter's thresholds).
export function quotaDetail(usage) {
  const windows = (usage?.windows || []).filter(window => Number.isFinite(window?.usedPercent));
  if (!windows.length) return null;
  const name = window => window.slot === 'five_hour' || window.minutes === 300 ? '5h' : window.slot === 'seven_day' || window.minutes === 10080 ? 'Week' : window.name;
  const worst = Math.max(...windows.map(window => window.usedPercent));
  return { detail: windows.map(window => `${name(window)} ${Math.round(window.usedPercent)}%`).join(' · ').slice(0, 80),
    tone: worst >= 90 ? 'error' : worst >= 70 ? 'warning' : 'muted' };
}

/** One composer choice per visible program: its fields and the account's saved session defaults. */
export function composerChoice(agent, codexList, { sessions = {}, options = {}, usage = [] } = {}) {
  const kind = sessionKind(agent), settings = options[kind] || {}, saved = sessions[settingsKey(agent)] || {};
  const { models } = sessionChoices(kind, codexList, settings, null);
  const fields = [];
  if (kind === 'claude' || kind === 'codex') {
    const efforts = sessionChoices(kind, codexList, settings, null).efforts;
    const supports = effort => kind === 'claude' ? null : models.filter(model => model.efforts?.includes(effort)).map(model => model.key);
    const model = models.find(model => model.key === saved.model) || models[0];
    const availableEfforts = sessionChoices(kind, codexList, settings, model?.key).efforts;
    if (!model || !availableEfforts.length) return null;
    fields.push({ id: 'model', label: 'Model', type: 'select', value: model.key,
      options: models.map(model => ({ key: model.key, label: model.label })) });
    fields.push({ id: 'effort', label: 'Effort', type: 'select', value: availableEfforts.includes(saved.effort) ? saved.effort : availableEfforts[0],
      options: efforts.map(effort => {
        const only = supports(effort);
        return { key: effort, label: effortLabel(effort), ...(only ? { only: { model: only } } : {}) };
      }) });
    if (kind === 'codex') fields.push({ id: 'fast', label: 'Fast', type: 'toggle', value: saved.serviceTier === 'fast' });
  }
  const quota = quotaDetail(usage.find(item => item?.key === agent.key));
  return { key: choiceKey(agent), label: (agent.profileKey || isAccountLauncher(agent)) && launcherLabel(agent.name) || agent.name, ...(agent.icon ? { icon: agent.icon } : {}),
    ...(agent.tint ? { tint: true } : {}), ...(quota || {}), fields };
}

/** The envelope for every discovered machine ('' is this computer), in the picker's order without hidden programs. */
export function composerEnvelope(cache, codexModelsByHome, userHome, state = {}) {
  const hidden = state.hidden || [], machines = {};
  for (const [key, profiles] of Object.entries(cache || {})) {
    if (!Array.isArray(profiles)) continue;
    const machine = JSON.parse(key) || null;
    const agents = launcherChoices(availableAgents(profiles, machine), state.order || [])
      .filter(choice => choice.agent && !hidden.includes(choice.key)).map(choice => choice.agent);
    const usage = state.usage?.contexts?.[JSON.stringify(machine)]?.usage || [];
    machines[machine || ''] = { choices: agents.map(agent => composerChoice(agent,
      machine ? [] : codexModelsByHome.get(codexHome(agent, userHome)) || [], { ...state, usage })).filter(Boolean) };
  }
  return { machines };
}

// The values a composer sent, as prepareSession options. Unknown fields are ignored; Default adds no flag.
export function intentOptions(values = {}) {
  const pick = value => typeof value === 'string' && value && value !== DEFAULT ? value : null;
  return { model: pick(values.model), effort: pick(values.effort), serviceTier: values.fast === true ? 'fast' : null };
}

export class Composer {
  codexModelsByHome = new Map();
  claimed = new Set();
  published = '';
  async loadModels() {
    const cache = shared('herdr-zed.agent-cache')?.[JSON.stringify(null)] || [];
    const dirs = [...new Set(cache.filter(agent => sessionKind(agent) === 'codex').map(agent => codexHome(agent, home())))];
    const lists = await Promise.all(dirs.map(async dir => [dir, codexModels(await readTextFile(`${dir}/models_cache.json`) || '')]));
    this.codexModelsByHome = new Map(lists);
  }
  publish(cx) {
    // Codex models load once their homes are discovered, then on the service's refresh.
    const cached = shared('herdr-zed.agent-cache')?.[JSON.stringify(null)], local = cached || [];
    // This computer is always offered; discovery is retried every 10 s while it has nothing cached.
    if (cx && !cached && !(this.discovering > Date.now())) {
      this.discovering = Date.now() + 10000;
      cx.spawn(async () => { try { await discoverAgents(null); this.discoveryError = null; } catch (error) { this.discoveryError = error.message; } });
    }
    if (cx && !this.loading && local.some(agent => sessionKind(agent) === 'codex' && !this.codexModelsByHome.has(codexHome(agent, home())))) {
      this.loading = true;
      cx.spawn(async () => { try { await this.loadModels(); } catch {} this.loading = false; });
    }
    const envelope = composerEnvelope(shared('herdr-zed.agent-cache'), this.codexModelsByHome, home(), {
      sessions: shared('herdr-zed.profile-sessions') || {}, options: shared('herdr-zed.session-options') || {},
      hidden: shared('herdr-zed.hidden-launchers') || [], order: shared('herdr-zed.launcher-order') || [],
      usage: shared('herdr-zed.usage.snapshot') || {} });
    const text = JSON.stringify(envelope);
    if (text === this.published) return;
    this.published = text;
    setShared(COMPOSER_KEY, { updatedAt: Date.now(), ...envelope });
  }
  // Intents addressed to this launcher are taken off the queue once; the shell only appends.
  poll(cx) {
    const queued = shared(LAUNCH_INTENTS) || [], now = Date.now();
    const mine = queued.filter(intent => intent?.launcher === LAUNCHER_ID);
    const rest = queued.filter(intent => intent?.launcher !== LAUNCHER_ID && intent?.expiresAt > now);
    if (!mine.length && rest.length === queued.length) return;
    setShared(LAUNCH_INTENTS, rest);
    for (const intent of mine) {
      if (this.claimed.has(intent.id) || !(intent.expiresAt > now)) continue;
      this.claimed.add(intent.id);
      cx.spawn(async () => {
        try {
          const machine = intent.target?.machine || null;
          const cache = shared('herdr-zed.agent-cache')?.[JSON.stringify(machine)] || [];
          const agent = availableAgents(cache, machine).find(item => choiceKey(item) === intent.choice);
          if (!agent) throw new Error('This program is no longer available. Choose another.');
          await emitLaunch(agent, { ...intent.target, ...(intent.task ? { task: intent.task } : {}) }, intentOptions(intent.values));
          // The composer's last choice becomes the account's default, like the picker's menus.
          const key = settingsKey(agent), sessions = shared('herdr-zed.profile-sessions') || {}, options = intentOptions(intent.values);
          setShared('herdr-zed.profile-sessions', { ...sessions, [key]: { ...sessions[key], model: options.model, effort: options.effort,
            ...(sessionKind(agent) === 'codex' ? { serviceTier: options.serviceTier } : {}) } });
        } catch (error) { notify({ title: 'Could not start thread', body: error.message, level: 'error' }); }
      });
    }
  }
}
