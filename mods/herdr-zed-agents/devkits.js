import { appHome, home, readTextFile, exec } from 'herdr';
import { sessionKind } from './components/session-model.js';
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
export async function sessionDevkits(agent, target = {}, switches = {}, argv = []) {
  const provider = sessionKind(agent), account = eccAccount(provider, argv, home());
  const guidance = await providerDevkits(provider, target, switches, account?.directory);
  if (!guidance?.flags?.length) return guidance;
  const executable = argv.findIndex(arg => new RegExp(`(?:^|[/\\\\])${provider}(?:\\.exe|\\.cmd)?$`, 'i').test(arg));
  if (executable < 0) throw Error('Could not find the shared Skills agent executable.');
  const pluginDir = provider === 'claude' ? argv.indexOf('--plugin-dir', executable + 1) : -1;
  if (pluginDir >= 0) return { ...guidance, argv: [...argv.slice(0, pluginDir + 1), guidance.flags[1], ...argv.slice(pluginDir + 1)] };
  return { ...guidance, argv: [...argv.slice(0, executable + 1), ...guidance.flags, ...argv.slice(executable + 1)] };
}
export async function providerDevkits(provider, target = {}, switches = {}, directory = '') {
  if (!['codex', 'claude'].includes(provider)) return null;
  const result = await exec('node', [`${appHome()}/mods/herdr-zed-agents/shared-skills-cli.js`, 'prepare', appHome(), provider,
    target.folder || '', JSON.stringify(switches), directory], { timeout: 240000 });
  if (result.code !== 0) throw Error(result.stderr?.trim() || 'Could not prepare shared skills.');
  return JSON.parse(result.stdout || 'null');
}

export async function providerCommands(agent, target = {}) {
  const provider = sessionKind(agent);
  if (target.machine || !['claude', 'codex'].includes(provider)) return [];
  const result = await exec('node', [`${appHome()}/mods/herdr-zed-agents/shared-skills-cli.js`, 'commands', appHome(), provider, target.folder || ''], { timeout: 30000 });
  if (result.code !== 0) throw Error(result.stderr?.trim() || 'Could not read available skills.');
  return JSON.parse(result.stdout || '[]');
}
