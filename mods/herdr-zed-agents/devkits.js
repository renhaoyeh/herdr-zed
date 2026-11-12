import { appHome, readTextFile, exec, window } from 'herdr';
import { sessionKind } from './components/session-model.js';
import { sharedMcpPath, parseSharedMcp } from './components/shared-mcp.js';
import { parseDevkits, devkitsCatalog, devkitsGuidance, resourceSupported, mineRoot, mineSelectionPath, mineItems, parseMineSelection, withMine } from './devkits-model.js';

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
  const result = await exec('node', [`${appHome()}/mods/herdr-zed-agents/capabilities-scan.js`, mineRoot(appHome())], { timeout: 10000 });
  if (result.code !== 0) throw Error(result.stderr?.trim() || 'Could not list your Rules and Skills.');
  const found = JSON.parse(result.stdout || '{}');
  const read = paths => Promise.all((paths || []).map(async path => ({ path, text: await readTextFile(path) })));
  return mineItems({ rules: await read(found.rules), skills: await read(found.skills) });
}
export const readMineSelection = async () => parseMineSelection(await readTextFile(mineSelectionPath(appHome())));

export const sessionDevkits = agent => providerDevkits(sessionKind(agent));
export async function providerDevkits(provider) {
  if (!['codex', 'claude'].includes(provider)) return null;
  const [text, mine, selection] = await Promise.all([readTextFile(devkitsPath()), readMineItems(), readMineSelection()]);
  const catalog = devkitsCatalog(appHome());
  for (const kind of ['rules', 'skills']) catalog[kind].push(...mine.filter(item => item.group === kind));
  const config = withMine(parseDevkits(text), catalog, selection);
  if (![...Object.values(config.rules), ...Object.values(config.skills)].some(Boolean)) return null;
  const servers = provider === 'codex' ? parseSharedMcp(await readTextFile(sharedMcpPath())).servers : {};
  const platform = window()?.platform;
  const loaded = await readDevkitsSkills(['rules', 'skills'].flatMap(kind =>
    catalog[kind].filter(item => !item.source && config[kind][item.id] && resourceSupported(item, platform))));
  for (const kind of ['rules', 'skills']) catalog[kind] = catalog[kind].map(item => {
    const resource = loaded.find(resource => resource.id === item.id);
    return resource ? { ...item, path: resource.path, text: resource.text } : item;
  });
  const missing = loaded.filter(skill => skill.text == null).map(skill => skill.path);
  return devkitsGuidance(config, catalog, servers, platform, missing, provider);
}
