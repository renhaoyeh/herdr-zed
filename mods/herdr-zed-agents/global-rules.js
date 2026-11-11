import { readTextFile, writeTextFile } from 'herdr';
import { rulesPath } from './components/agents.js';
import { defaultRules } from './global-rules-model.js';
export { rulesPath } from './components/agents.js';

export async function sessionRules() {
  const source = await readTextFile(rulesPath());
  if (!source?.trim()) return null;
  return { file: rulesPath(), text: source, composed: true };
}

// Never replace an existing Guide, including one deliberately left empty.
export async function ensureRules() {
  if (await readTextFile(rulesPath()) === null) await writeTextFile(rulesPath(), defaultRules, null);
}
