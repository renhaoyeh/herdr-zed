import { appHome, home, readTextFile, exec } from 'herdr';
import { sessionKind, codexHome } from './components/session-model.js';
import { eccAccount } from './ecc-model.js';

export const devkitsPath = () => `${appHome()}/data/herdr-zed/capabilities.json`;
export async function readDevkitsSkills(skills) {
  return Promise.all(skills.map(async skill => {
    const policy = skill.policyPath ? await readTextFile(skill.policyPath) : null;
    const path = policy != null ? skill.policyPath : skill.path;
    return { ...skill, path, text: policy != null ? policy : await readTextFile(skill.path) };
  }));
}
// The user's own Rules and Skills with their text, read from data/herdr-zed/capabilities.
export async function readMineItems() {
  const result = await exec('node', [`${appHome()}/mods/herdr-zed-agents/shared-skills-cli.js`, 'list', appHome()], { timeout: 15000 });
  if (result.code !== 0) throw Error(result.stderr?.trim() || 'Could not list your Rules and Skills.');
  return JSON.parse(result.stdout || '[]');
}
export async function sessionDevkits(agent, target = {}, switches = {}, argv = [], options = {}) {
  const provider = sessionKind(agent), account = eccAccount(provider, argv, home());
  let guidance = await providerDevkits(provider, target, switches, account?.directory, options);
  if (provider === 'codex' && String(options.command || '').startsWith('codex:') || provider === 'codex' && !options.command && /^\s*\/[^\s]/.test(target.task || ''))
    guidance = { ...guidance, commands: await withCodexSkills(guidance?.commands || [], account.directory, target.folder) };
  if (!guidance?.flags?.length) return guidance;
  const executable = argv.findIndex(arg => new RegExp(`(?:^|[/\\\\])${provider}(?:\\.exe|\\.cmd)?$`, 'i').test(arg));
  if (executable < 0) throw Error('Could not find the shared Skills agent executable.');
  return { ...guidance, argv: mergeSkillFlags(argv, provider, guidance.flags, executable) };
}

export function mergeSkillFlags(argv, provider, flags, executable) {
  const next = [...argv], extra = [...flags];
  if (provider === 'claude') {
    const plugin = extra.indexOf('--plugin-dir'), current = next.indexOf('--plugin-dir', executable + 1);
    if (plugin >= 0 && current >= 0) { next.splice(current + 1, 0, extra[plugin + 1]); extra.splice(plugin, 2); }
    const settings = extra.indexOf('--settings'), previous = next.indexOf('--settings', executable + 1);
    if (settings >= 0 && previous >= 0) {
      let base, change;
      try { base = JSON.parse(next[previous + 1]); change = JSON.parse(extra[settings + 1]); }
      catch { throw Error('Project skill overrides require inline JSON when Claude --settings is supplied.'); }
      if (!base || typeof base !== 'object' || Array.isArray(base)) throw Error('Claude settings must be an object.');
      const merged = { ...base, ...change };
      for (const key of Object.keys(change)) if (base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) merged[key] = { ...base[key], ...change[key] };
      next[previous + 1] = JSON.stringify(merged); extra.splice(settings, 2);
    }
  }
  return [...next.slice(0, executable + 1), ...extra, ...next.slice(executable + 1)];
}
export async function providerDevkits(provider, target = {}, switches = {}, directory = '', options = {}) {
  if (!['codex', 'claude'].includes(provider)) return null;
  const result = await exec('node', [`${appHome()}/mods/herdr-zed-agents/shared-skills-cli.js`, 'prepare', appHome(), provider,
    target.folder || '', JSON.stringify(switches), directory, JSON.stringify({ eccProfile: options.eccProfile, userHome: home() })], { timeout: 240000 });
  if (result.code !== 0) throw Error(result.stderr?.trim() || 'Could not prepare shared skills.');
  return JSON.parse(result.stdout || 'null');
}

export async function providerCommands(agent, target = {}) {
  const provider = sessionKind(agent);
  if (target.machine || !['claude', 'codex'].includes(provider)) return [];
  const result = await exec('node', [`${appHome()}/mods/herdr-zed-agents/shared-skills-cli.js`, 'commands', appHome(), provider, target.folder || '', '{}', '', JSON.stringify(provider === 'claude' ? { userHome: home() } : {})], { timeout: 30000 });
  if (result.code !== 0) throw Error(result.stderr?.trim() || 'Could not read available skills.');
  const commands = JSON.parse(result.stdout || '[]');
  if (provider !== 'codex') return commands;
  // The composer receives id/name/description only; the launch resolves paths again.
  return (await withCodexSkills(commands, codexHome(agent, home()), target.folder)).map(({ id, name, description }) => ({ id, name, description }));
}
// Add the Codex account's own installed skills; shared entries keep their names.
export async function withCodexSkills(commands, directory, folder = '') {
  const result = await exec('node', [`${appHome()}/mods/herdr-zed-agents/native-skills-cli.js`, 'inventory', appHome(), JSON.stringify({ userHome: home(), provider: 'codex', directory, folder })], { timeout: 60000 });
  if (result.code !== 0) throw Error(result.stderr?.trim() || 'Could not read installed Codex skills.');
  const names = new Set(commands.map(item => item.name));
  return [...commands, ...JSON.parse(result.stdout || '{}').items.filter(item => item.active && item.path && !names.has(item.name))];
}
