import { appHome, home, readTextFile, exec } from 'herdr';
import { parseEcc, eccAccount } from './ecc-model.js';
import { sessionKind } from './components/session-model.js';
import { eccProfilePlan } from './ecc-profiles.js';

export const eccPath = () => `${appHome()}/data/herdr-zed/ecc.json`;
async function selectedGuidance(path) {
  if (!path) return '';
  const text = await readTextFile(path);
  if (!text) throw new Error('Selected ECC guidance is unavailable. Retry session preparation.');
  return text;
}
export async function prepareEcc(agent, argv, target = {}, options = {}) {
  const profile = options.eccProfile ?? null;
  const account = eccAccount(sessionKind(agent), argv, home());
  if (profile !== null) {
    eccProfilePlan([], account?.provider, profile);
    if (target.machine || !target.folder) throw new Error('ECC profiles require a local project folder.');
  }
  if (!account) return { argv, instructions: '' };
  if (target.folder) {
    const result = await exec('node', [`${appHome()}/mods/herdr-zed-agents/ecc-project-runtime.js`, appHome(), target.folder, account.provider, account.directory,
      ...(profile === null ? [] : [profile])], { timeout: 240000 });
    if (result.code !== 0) throw new Error(result.stderr?.trim() || 'Could not prepare project ECC settings.');
    const project = JSON.parse(result.stdout || 'null');
    if (project) {
      const executable = argv.findIndex(arg => new RegExp(`(?:^|[/\\\\])${account.provider}(?:\\.exe|\\.cmd)?$`, 'i').test(arg));
      if (executable < 0) throw new Error('Could not find the project agent executable.');
      return { argv: [...argv.slice(0, executable + 1), ...project.flags, ...argv.slice(executable + 1)], mcp: project.mcp,
        instructions: await selectedGuidance(project.instructionsFile) };
    }
  }
  const text = await readTextFile(eccPath());
  parseEcc(text);
  const result = await exec('node', [`${appHome()}/mods/herdr-zed-agents/ecc-sync.js`, account.provider, account.directory, eccPath()], { timeout: 240000 });
  if (result.code !== 0) throw new Error(result.stderr?.trim() || 'Could not apply global ECC settings. Open Agent settings → ECC and retry.');
  const resultData = JSON.parse(result.stdout || '{}');
  return { argv, instructions: await selectedGuidance(resultData.instructionsFile) };
}
