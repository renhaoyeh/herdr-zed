// Rule content stays in the editable Guide; switches control only session injection.
export const ruleModules = [];
export const ruleSettingsKey = 'herdr-zed.global-rules';
export const defaultRules = '';

export function ruleSelection(saved = {}) {
  return Object.fromEntries([...ruleModules.map(item => item.key), 'custom'].map(key => [key, saved?.[key] !== false]));
}

export function splitRuleGuide(text) {
  const sections = {}, custom = [];
  let source = (text || '').replace(/^# Global rules\r?\n(?:\r?\nShared startup instructions for Herdr Devkits agent sessions\.)?\s*/, '');
  const customStart = source.search(/^## Custom rules\s*$/m);
  let customText = '';
  if (customStart >= 0) {
    customText = source.slice(customStart).replace(/^## Custom rules\s*\r?\n?/, '').trim();
    source = source.slice(0, customStart);
  }
  for (const part of source.split(/(?=^## )/m)) {
    if (!part.trim()) continue;
    const heading = part.split(/\r?\n/)[0].replace(/^## /, '').trim();
    const item = ruleModules.find(item => item.heading === heading);
    if (item) sections[item.key] = [sections[item.key], part.trim()].filter(Boolean).join('\n\n');
    else custom.push(part.trim());
  }
  if (customText) custom.push(customText);
  return { sections, custom: custom.join('\n\n') };
}

export function composeRuleGuide(guide, selected) {
  const parts = ruleModules.filter(item => selected[item.key]).map(item => guide.sections[item.key] ?? item.text);
  if (selected.custom && guide.custom.trim()) parts.push('## Custom rules\n\n' + guide.custom.trim());
  return parts.length ? '# Global rules\n\n' + parts.join('\n\n') + '\n' : '';
}
