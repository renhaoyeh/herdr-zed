// Skills already installed in a Codex account, as Codex itself resolves them for a project folder.
import { isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { openConfig } from './codex-config.js';
import { isMain } from './node-main.js';

const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;

/** Enabled skills with a local SKILL.md, as New Thread slash commands. */
export async function readCodexSkills(directory, folder = '', { open = openConfig } = {}) {
  if (typeof directory !== 'string' || !isAbsolute(directory)) throw Error('Choose an absolute Codex account directory.');
  const service = await open(directory);
  try {
    const result = await service.request('skills/list', { cwds: [folder && isAbsolute(folder) ? folder : directory], forceReload: true });
    if (!Array.isArray(result?.data)) throw Error('Codex returned no skill inventory.');
    const commands = new Map();
    // Plain skill names claim their slash name before plugin `plugin:skill` short names.
    const skills = result.data.flatMap(entry => entry.skills || []).sort((a, b) => Number(a?.name?.includes(':')) - Number(b?.name?.includes(':')));
    for (const skill of skills) {
      if (skill?.enabled !== true || typeof skill.path !== 'string' || !isAbsolute(skill.path) || typeof skill.name !== 'string') continue;
      // Plugin skills are named `plugin:skill`; slash names use the skill part, or plugin-skill on a clash.
      const short = skill.name.split(':').pop(), full = skill.name.replaceAll(':', '-');
      const name = [short, full].find(name => NAME.test(name) && !commands.has(name));
      if (!name) continue;
      const id = `codex:${createHash('sha256').update(skill.path).digest('hex').slice(0, 16)}`;
      commands.set(name, { id, name, description: String(skill.description || '').slice(0, 500), path: skill.path });
    }
    return [...commands.values()].sort((a, b) => a.name.localeCompare(b.name));
  } finally { await service.close(); }
}

if (await isMain(import.meta.url)) {
  try {
    const [action, directory, folder] = process.argv.slice(2);
    if (action !== 'list') throw Error('Unknown Codex skill action.');
    console.log(JSON.stringify(await readCodexSkills(directory, folder || '')));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
