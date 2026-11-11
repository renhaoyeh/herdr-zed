import { appHome, readTextFile, window } from 'herdr';
import { sessionKind } from './components/session-model.js';
import { sharedMcpPath, parseSharedMcp } from './components/shared-mcp.js';
import { parseDevkits, devkitsCatalog, devkitsGuidance, resourceSupported } from './devkits-model.js';

export const devkitsPath = () => `${appHome()}/data/devkits/capabilities.json`;
export async function readDevkitsSkills(skills) {
  return Promise.all(skills.map(async skill => {
    const policy = skill.policyPath ? await readTextFile(skill.policyPath) : null;
    const path = policy != null ? skill.policyPath : skill.path;
    return { ...skill, path, text: policy != null ? policy : await readTextFile(skill.path) };
  }));
}
export async function sessionDevkits(agent) {
  const provider = sessionKind(agent);
  if (!['codex', 'claude'].includes(provider)) return '';
  const config = parseDevkits(await readTextFile(devkitsPath()));
  if (![...Object.values(config.rules), ...Object.values(config.skills)].some(Boolean)) return '';
  const catalog = devkitsCatalog(appHome());
  const servers = provider === 'codex' ? parseSharedMcp(await readTextFile(sharedMcpPath())).servers : {};
  const platform = window()?.platform;
  const loaded = await readDevkitsSkills(['rules', 'skills'].flatMap(kind => catalog[kind].filter(item => config[kind][item.id] && resourceSupported(item, platform))));
  for (const kind of ['rules', 'skills']) catalog[kind] = catalog[kind].map(item => {
    const resource = loaded.find(resource => resource.id === item.id);
    return resource ? { ...item, path: resource.path, text: resource.text } : item;
  });
  const missing = loaded.filter(skill => skill.text == null).map(skill => skill.path);
  return devkitsGuidance(config, catalog, servers, platform, missing, provider);
}
