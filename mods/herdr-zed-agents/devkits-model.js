import { sharedMcpPlatforms } from './components/shared-mcp-model.js';

const devkitsDefinitions = [
  { id: 'core', group: 'rules', name: 'Herdr Core', icon: 'terminal', description: 'Follow the installed Herdr manual when operating terminals.', skill: 'herdr-core', mcps: [] },
  { id: 'tasks', group: 'rules', name: 'Task progress', icon: 'list-todo', description: 'Report progress during actual user work; ordinary chat and discussion need no reports.', skill: 'herdr-tasks', mcps: ['herdr_tasks'] },
  { id: 'shared-mcp', group: 'skills', name: 'Shared MCP installation', icon: 'settings', description: 'Install or configure shared local Codex MCP connections when requested, preserving existing account settings.', skill: 'shared-mcp', mcps: [] },
  { id: 'visual-studio', group: 'skills', name: 'Visual Studio builds', icon: 'gear', description: 'Build the intended Visual Studio solution and inspect its diagnostics.', skill: 'visual-studio', mcps: ['visual_studio'], platforms: sharedMcpPlatforms.visual_studio },
];
export const devkitsGroups = [
  { id: 'rules', label: 'Rules', description: 'Selected rules guide each new conversation. Task reporting applies only during actual work.' },
  { id: 'skills', label: 'Skills', description: 'Reusable methods loaded when the task needs them.' },
  { id: 'mcp', label: 'MCP', description: 'Actual tool connections. Configure, verify and enable each connection here.' },
];
export const devkitsMcpPresets = [{ id: 'visual_studio', name: 'Visual Studio', platforms: sharedMcpPlatforms.visual_studio,
  url: 'https://github.com/renhaoyeh/vs-mcp#installation-and-connection',
  setup: 'Install the official VSIX on Windows, start Visual Studio once to install its bridge, and install the .NET 10 runtime. Detect the bridge or choose its executable, then test the connection. The bridge can be tested without starting an IDE or building a solution.' }];
export const resourceSupported = (item, platform) => !item.platforms || item.platforms.includes(platform);

export function devkitsCatalog(root) {
  const items = devkitsDefinitions.map(({ skill, ...item }) => ({ ...item,
    path: `${root}/mods/herdr-zed-agents/assets/skills/${skill}/SKILL.md`, policyPath: `${root}/data/devkits/skills/${skill}/SKILL.md` }));
  return { rules: items.filter(item => item.group === 'rules'), skills: items.filter(item => item.group === 'skills') };
}
export function parseDevkits(text) {
  const defaults = group => Object.fromEntries(devkitsDefinitions.filter(item => item.group === group).map(item => [item.id, true]));
  if (text == null) return { version: 2, rules: defaults('rules'), skills: defaults('skills') };
  const value = JSON.parse(text), object = item => item && typeof item === 'object' && !Array.isArray(item);
  const legacy = value?.version === 1, kinds = legacy ? ['skills', 'workflows'] : ['rules', 'skills'];
  if (!object(value) || ![1, 2].includes(value.version) || Object.keys(value).some(key => !['version', ...kinds].includes(key))
    || kinds.some(kind => !object(value[kind]) || Object.entries(value[kind]).some(([id, enabled]) =>
      !devkitsDefinitions.some(item => item.id === id && (legacy || item.group === kind)) || typeof enabled !== 'boolean')))
    throw Error('Invalid Devkits selections. Expected known boolean resource selections.');
  // Preserve resource choices from the previous Skill/Workflow draft; duplicated workflows no longer run.
  return { version: 2, ...Object.fromEntries(['rules', 'skills'].map(kind => [kind,
    Object.fromEntries(devkitsDefinitions.filter(item => item.group === kind).map(item => [item.id, (legacy ? value.skills : value[kind])[item.id] ?? true]))])) };
}
export function resourceProblems(item, config, servers, platform, missingSkills = []) {
  return [
    ...(!resourceSupported(item, platform) ? ['Windows only'] : []),
    ...item.mcps.filter(name => name !== 'herdr_tasks' && !servers[name]).map(name => `Setup required: ${name}`),
    ...item.mcps.filter(name => name !== 'herdr_tasks' && servers[name]?.enabled === false).map(name => `MCP is off: ${name}`),
    ...(item.path && missingSkills.includes(item.path) ? ['Bundled skill unavailable'] : []),
  ];
}
export function devkitsPlan(config, catalog, request, servers, platform, missingSkills = []) {
  const rules = [...new Set(request.rules || [])], skills = [...new Set(request.skills || [])];
  const items = [...rules.map(id => catalog.rules.find(item => item.id === id)), ...skills.map(id => catalog.skills.find(item => item.id === id))];
  if (items.some(item => !item)) throw Error('Unknown Devkits resource.');
  const blocked = items.flatMap(item => [
    ...(!resourceSupported(item, platform) ? [`${item.name}: Windows only`] : []),
    ...(missingSkills.includes(item.path) ? [`${item.name}: resource unavailable`] : []),
  ]);
  const mcps = [...new Set(items.flatMap(item => item.mcps))].filter(name => name !== 'herdr_tasks');
  return { rules, skills, blocked, missing: mcps.filter(name => !servers[name]), enable: mcps.filter(name => servers[name]?.enabled === false),
    addedRules: rules.filter(id => config.rules[id] !== true), addedSkills: skills.filter(id => config.skills[id] !== true) };
}
export function applyDevkitsPlan(config, mcpConfig, plan) {
  if (plan.blocked.length || plan.missing.length) throw Error('Complete the required setup before selecting these resources.');
  return { config: { ...config, rules: { ...config.rules, ...Object.fromEntries(plan.rules.map(id => [id, true])) },
    skills: { ...config.skills, ...Object.fromEntries(plan.skills.map(id => [id, true])) } },
    mcp: { ...mcpConfig, servers: { ...mcpConfig.servers, ...Object.fromEntries(plan.enable.map(name => [name, { ...mcpConfig.servers[name], enabled: true }])) } } };
}
export function mcpUsers(name, config, catalog) {
  return ['rules', 'skills'].flatMap(kind => catalog[kind].filter(item => config[kind][item.id] === true && item.mcps.includes(name)).map(item => item.name));
}
export function devkitsGuidance(config, catalog, servers, platform, missingSkills = [], provider = 'codex') {
  const scoped = item => provider === 'claude' ? { ...item, mcps: item.mcps.filter(name => name === 'herdr_tasks') } : item;
  const usable = kind => catalog[kind].filter(item => config[kind][item.id] === true && !resourceProblems(scoped(item), config, servers, platform, missingSkills).length);
  return [
    ...usable('rules').map(item => `## ${item.name}\n\n${item.description}\n\n${(item.text || '').replace(/^---\r?\n[\s\S]*?\r?\n---\s*/, '')}`),
    ...usable('skills').map(item => `## ${item.name}\n\n${item.description}${provider === 'claude' && item.mcps.some(name => name !== 'herdr_tasks') ? '\nUse only when the required MCP tools are available in this Claude session. Devkits shared connection setup configures Codex; Claude uses its account MCP configuration.' : ''}\nRead the skill ${JSON.stringify(item.path)} when relevant to the user's task; resolve supporting files relative to it.`),
  ].join('\n\n');
}
