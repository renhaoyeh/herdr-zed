import { readTextFile, writeTextFile, shared } from 'herdr';
import { rulesPath } from './components/agents.js';
import { defaultRules, splitRuleGuide, composeRuleGuide, ruleSelection, ruleSettingsKey } from './global-rules-model.js';
export { rulesPath } from './components/agents.js';

export async function sessionRules() {
  const source = await readTextFile(rulesPath());
  if (!source?.trim()) return null;
  const text = composeRuleGuide(splitRuleGuide(source), ruleSelection(shared(ruleSettingsKey)));
  return text ? { file: rulesPath(), text, composed: true } : null;
}

// Never replace an existing Guide, including one deliberately left empty.
export async function ensureRules() {
  if (await readTextFile(rulesPath()) === null) await writeTextFile(rulesPath(), defaultRules, null);
}
