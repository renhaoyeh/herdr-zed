import { sharedMcpPlatforms } from './components/shared-mcp-model.js';
import { demoteHeadings } from './global-rules-model.js';

const devkitsDefinitions = [
  { id: 'core', group: 'rules', name: 'Herdr Core', icon: 'terminal', description: 'Follow the installed Herdr manual when operating terminals.', skill: 'herdr-core', mcps: [] },
  { id: 'tasks', group: 'rules', name: 'Task progress', icon: 'list-todo', description: 'Report progress during actual user work; ordinary chat and discussion need no reports.', skill: 'herdr-tasks', mcps: ['herdr_tasks'] },
  { id: 'shared-mcp', group: 'skills', name: 'Shared MCP installation', icon: 'settings', description: 'Install or configure shared local MCP connections for Codex and Claude Code when requested, preserving existing account settings.', skill: 'shared-mcp', mcps: [], providers: ['codex', 'claude'] },
  { id: 'project-capabilities', group: 'skills', name: 'ECC, MCP and Skills', icon: 'extensions', description: 'Explain this Herdr layout’s ECC, skills and MCP configuration from any conversation, including what is enabled and what each item does; recommend or apply project choices when requested.', skill: 'project-capabilities', mcps: [], providers: ['codex', 'claude'] },
  { id: 'visual-studio', group: 'skills', name: 'Visual Studio builds', icon: 'gear', description: 'Build the intended Visual Studio solution and inspect its diagnostics.', skill: 'visual-studio', mcps: ['visual_studio'], platforms: sharedMcpPlatforms.visual_studio },
];
export const devkitsMcpPresets = [{ id: 'visual_studio', name: 'Visual Studio', platforms: sharedMcpPlatforms.visual_studio,
  url: 'https://github.com/renhaoyeh/vs-mcp#installation-and-connection',
  setup: 'Install the official VSIX on Windows, start Visual Studio once to install its bridge, and install the .NET 10 runtime. Detect the bridge or choose its executable, then test the connection. The bridge can be tested without starting an IDE or building a solution.' }];
export const resourceSupported = (item, platform) => !item.platforms || item.platforms.includes(platform);

export function devkitsCatalog(root) {
  const items = devkitsDefinitions.map(({ skill, ...item }) => ({ ...item,
    path: `${root}/mods/herdr-zed-agents/assets/skills/${skill}/SKILL.md`, policyPath: `${root}/data/herdr-zed/skills/${skill}/SKILL.md` }));
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
// Skill bodies start with their own title; under "## <name>" the rest moves down one level.
const ruleBody = text => demoteHeadings(stripFrontmatter(text).replace(/^\s*#\s[^\n]*\n/, '').trim(), 1);
const stripFrontmatter = text => (text || '').replace(/^---\r?\n[\s\S]*?\r?\n---\s*/, '');
const plainPath = path => path.replace(/\\/g, '/');

// The user's own Rules and Skills: data/herdr-zed/capabilities/rules/*.md and skills/<name>/SKILL.md.
// They are on unless listed in data/herdr-zed/capabilities.json, so a new file takes effect without a switch.
export const mineRoot = root => `${root}/data/herdr-zed/capabilities`;
export const mineSelectionPath = root => `${root}/data/herdr-zed/capabilities.json`;
export function frontmatter(text) {
  const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text || '')?.[1] || '';
  const field = key => new RegExp(`^${key}:[ \\t]*(.+)$`, 'm').exec(head)?.[1].trim().replace(/^(['"])(.*)\1$/, '$2') || '';
  return { name: field('name'), description: field('description') };
}
export function mineItems(found) {
  return ['rules', 'skills'].flatMap(kind => (found?.[kind] || []).filter(file => file.text != null).map(file => {
    const meta = frontmatter(file.text), base = plainPath(file.path).split('/').filter(Boolean);
    const slug = kind === 'rules' ? base.at(-1).replace(/\.md$/i, '') : base.at(-2);
    const lead = stripFrontmatter(file.text).split(/\r?\n/).map(line => line.trim()).find(line => line && !line.startsWith('#')) || '';
    return { id: `mine:${kind}:${slug}`, group: kind, source: 'mine', name: meta.name || slug, icon: 'file',
      description: meta.description || lead, path: file.path, text: file.text, mcps: [] };
  }));
}
export function parseMineSelection(text) {
  if (text == null) return { version: 1, disabled: [] };
  const value = JSON.parse(text);
  if (value?.version !== 1 || !Array.isArray(value.disabled) || value.disabled.some(id => typeof id !== 'string'))
    throw Error('Invalid capabilities.json. Expected { "version": 1, "disabled": [ids] }.');
  return { version: 1, disabled: value.disabled };
}
/** Built-in selections plus the user's items, which are on unless disabled. */
export function withMine(config, catalog, mine) {
  const merged = { ...config, rules: { ...config.rules }, skills: { ...config.skills } };
  for (const kind of ['rules', 'skills']) for (const item of catalog[kind].filter(item => item.source === 'mine'))
    merged[kind][item.id] = !mine.disabled.includes(item.id);
  return merged;
}
export const providerSupported = (item, provider) => !item.providers || item.providers.includes(provider);

export function devkitsGuidance(config, catalog, servers, platform, missingSkills = [], provider = 'codex') {
  const usable = kind => catalog[kind].filter(item => config[kind][item.id] === true && providerSupported(item, provider)
    && !resourceProblems(item, config, servers, platform, missingSkills).length);
  const items = [
    ...usable('rules').map(item => ({ id: item.id, name: item.name, kind: 'rule', source: item.source || 'built-in', description: item.description,
      body: ruleBody(item.text) })),
    ...usable('skills').map(item => ({ id: item.id, name: item.name, kind: 'skill', source: item.source || 'built-in', description: item.description,
      body: `Read the skill \`${plainPath(item.path)}\` when relevant to the user's task; resolve supporting files relative to it.` })),
  ];
  if (!items.length) return null;
  return {
    items,
    summary: items.map(item => `- **${item.name}** (${item.kind}): ${item.description}`).join('\n'),
    sections: items.map(item => [`## ${item.name}`, item.body].filter(Boolean).join('\n\n')).join('\n\n'),
  };
}
