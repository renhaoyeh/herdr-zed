import { appHome, home, readTextFile, exec } from 'herdr';
import { parseEcc, eccAccount } from './ecc-model.js';
import { sessionKind } from './components/session-model.js';

export const eccPath = () => `${appHome()}/data/devkits/ecc.json`;
export async function prepareEcc(agent, argv) {
  const text = await readTextFile(eccPath());
  if (text === null || text === undefined) return { argv, instructions: '' };
  const account = eccAccount(sessionKind(agent), argv, home());
  if (!account) return { argv, instructions: '' };
  parseEcc(text);
  const result = await exec('node', [`${appHome()}/mods/herdr-zed-agents/ecc-sync.js`, account.provider, account.directory, eccPath()], { timeout: 240000 });
  if (result.code !== 0) throw new Error(result.stderr?.trim() || 'Could not apply global ECC settings. Open Agent settings → ECC and retry.');
  const resultData = JSON.parse(result.stdout || '{}');
  return { argv, instructions: resultData.instructionsFile ? `Read and follow the selected ECC rules and context in this file before doing any work:\n${resultData.instructionsFile}` : '' };
}
