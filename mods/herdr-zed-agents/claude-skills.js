// Inherit personal skill instructions without copying account settings, hooks or MCPs.
import { readdir, readFile } from 'node:fs/promises';
import { join, basename, resolve, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { frontmatter } from './devkits-model.js';
import { publishTree, skillTree } from './shared-skills.js';

const optional = async path => { try { return await readFile(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const entries = async path => { try { return await readdir(path, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };
const digest = text => createHash('sha256').update(text).digest('hex');
const validName = name => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(name);

export async function readClaudeSkills(userHome) {
  if (!isAbsolute(userHome)) throw Error('Choose an absolute user home for Claude skills.');
  const found = [], root = join(userHome, '.claude', 'skills');
  const settings = JSON.parse(await optional(join(userHome, '.claude', 'settings.json')) || '{}');
  async function read(folder) {
    const path = join(folder, 'SKILL.md'), text = await optional(path);
    if (text === null) return;
    const metadata = frontmatter(text), name = metadata.name || basename(folder);
    if (!validName(name) || !metadata.description) return;
    const header = /^---\r?\n[\s\S]*?\r?\n---/.exec(text)?.[0];
    found.push({ id: `claude:${digest(path).slice(0, 16)}`, name, description: metadata.description.slice(0, 500), path, header,
      userInvocable: !/^user-invocable:\s*false\s*$/m.test(header) });
  }
  for (const entry of (await entries(root)).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.') || entry.name === 'synced' || !entry.isDirectory()) continue;
    const folder = join(root, entry.name);
    const manifest = await optional(join(folder, '.claude-plugin', 'plugin.json'));
    if (manifest === null) { await read(folder); continue; }
    const plugin = JSON.parse(manifest);
    if (settings.enabledPlugins?.[`${plugin.name || entry.name}@skills-dir`] === false) continue;
    const paths = plugin.skills === undefined ? ['./skills'] : Array.isArray(plugin.skills) ? plugin.skills : [plugin.skills];
    for (const source of paths) {
      if (typeof source !== 'string') throw Error(`Invalid personal plugin skills path: ${folder}`);
      const directory = resolve(folder, source), inside = relative(folder, directory);
      if (inside === '..' || inside.startsWith('../') || inside.startsWith('..\\') || isAbsolute(inside)) throw Error(`Personal plugin skills escape their folder: ${folder}`);
      for (const child of (await entries(directory)).sort((a, b) => a.name.localeCompare(b.name)))
        if (!child.name.startsWith('.') && child.isDirectory()) await read(join(directory, child.name));
    }
  }
  return found;
}

export async function inheritClaudeSkills(home, guidance, userHome) {
  const skills = await readClaudeSkills(userHome);
  const commands = [...(guidance?.commands || [])], nativeSkills = [...(guidance?.nativeSkills || [])];
  const names = new Set([...commands, ...nativeSkills].map(item => item.name));
  for (const skill of skills) {
    if (names.has(skill.name)) continue;
    names.add(skill.name);
    // Keep the full invocation policy and resolve supporting files from the source.
    const text = `${skill.header}\n\nRead and follow the original skill at ${JSON.stringify(skill.path.replaceAll('\\', '/'))}. Resolve all relative links and resources from its original directory. If the source is missing, report it instead of guessing.\n`;
    const content = Buffer.from(text), revision = digest(text);
    const snapshot = await publishTree(join(home, 'data', 'herdr-zed', 'skill-snapshots'), { revision, files: [{ path: 'SKILL.md', content, executable: false }] });
    nativeSkills.push({ id: skill.id, name: skill.name, path: snapshot, revision: (await skillTree(snapshot)).revision });
    if (skill.userInvocable) commands.push({ id: skill.id, name: skill.name, description: skill.description, path: join(snapshot, 'SKILL.md') });
  }
  return skills.length ? { ...guidance, commands, nativeSkills } : guidance;
}
