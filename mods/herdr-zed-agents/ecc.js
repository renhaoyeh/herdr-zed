import { appHome, home, readTextFile, exec } from 'herdr';
import { parseEcc, eccAccount } from './ecc-model.js';
import { sessionKind } from './components/session-model.js';

export const eccPath = () => `${appHome()}/data/herdr-zed/ecc.json`;
export async function prepareEcc(agent, argv, target = {}) {
  const account = eccAccount(sessionKind(agent), argv, home());
  if (!account) return { argv, instructions: '' };
  if (target.folder) {
    const result = await exec('node', [`${appHome()}/mods/herdr-zed-agents/ecc-project-runtime.js`, appHome(), target.folder, account.provider, account.directory], { timeout: 240000 });
    if (result.code !== 0) throw new Error(result.stderr?.trim() || 'Could not prepare project ECC settings.');
    const project = JSON.parse(result.stdout || 'null');
    if (project) {
      const executable = argv.findIndex(arg => new RegExp(`(?:^|[/\\\\])${account.provider}(?:\\.exe|\\.cmd)?$`, 'i').test(arg));
      if (executable < 0) throw new Error('Could not find the project agent executable.');
      return { argv: [...argv.slice(0, executable + 1), ...project.flags, ...argv.slice(executable + 1)], mcp: project.mcp,
        instructions: project.instructionsFile ? `Read and follow the selected project ECC rules and context before doing work:\n${project.instructionsFile}` : '' };
    }
  }
  const text = await readTextFile(eccPath());
  if (text === null || text === undefined) return { argv, instructions: '' };
  parseEcc(text);
  const result = await exec('node', [`${appHome()}/mods/herdr-zed-agents/ecc-sync.js`, account.provider, account.directory, eccPath()], { timeout: 240000 });
  if (result.code !== 0) throw new Error(result.stderr?.trim() || 'Could not apply global ECC settings. Open Agent settings → ECC and retry.');
  const resultData = JSON.parse(result.stdout || '{}');
  return { argv, instructions: resultData.instructionsFile ? `Read and follow the selected ECC rules and context in this file before doing any work:\n${resultData.instructionsFile}` : '' };
}
