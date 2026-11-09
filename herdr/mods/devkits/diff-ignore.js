import { appHome, readTextFile, writeTextFile } from 'herdr';
import { execShell } from './shell.js';

export const buildRulesPath = () => `${appHome()}/data/devkits/diff-build-output.gitignore`;

/** Seed once from the unmodified downloaded templates. Never replace saved edits or emptiness. */
export async function readBuildRules() {
  const path = buildRulesPath();
  let text = await readTextFile(path);
  if (text === null) {
    const names = ['VisualStudio.gitignore', 'Qt.gitignore'];
    const templates = await Promise.all(names.map(name => readTextFile(`${appHome()}/mods/devkits/assets/gitignore/${name}`)));
    if (templates.some(value => value === null)) throw new Error('Build filter templates are missing.');
    const initial = '# Herdr display filter: untracked files only. Git configuration is unchanged.\n'
      + '# Edit these rules or append patterns and !exceptions below.\n\n'
      + templates.map((value, i) => `# github/gitignore/${names[i]}\n${value}\n`).join('\n')
      + '\n# Additional rules and exceptions\n';
    try { await writeTextFile(path, initial, null); text = initial; }
    catch (error) {
      text = await readTextFile(path);
      if (text === null) throw error;
    }
  }
  return { path: path.replaceAll('\\', '/'), text };
}

/** Local Git reads the saved file directly. Remote Git gets a short-lived copy in its temp folder. */
export async function withBuildRulesFile(rules, on, read) {
  if (!rules) return read('');
  if (!on) return read(rules.path);
  const created = await execShell(['-c', 'mktemp "${TMPDIR:-/tmp}/devkits-diff-ignore.XXXXXX"'], { on });
  const path = created.stdout.trim();
  if (created.code !== 0 || !/(?:^|\/)devkits-diff-ignore\.[A-Za-z0-9]+$/.test(path)) throw new Error('Cannot prepare remote build filters.');
  try {
    // Bound each command line, including on Windows; filenames never enter shell code.
    for (let offset = 0; offset < rules.text.length;) {
      let end = Math.min(offset + 4096, rules.text.length);
      if (end < rules.text.length && /[\ud800-\udbff]/.test(rules.text[end - 1])) end--;
      const result = await execShell(['-c', 'printf "%s" "$2" >> "$1"', 'devkits-diff-ignore', path,
        rules.text.slice(offset, end)], { on });
      if (result.code !== 0) throw new Error(result.stderr || 'Cannot copy build filters.');
      offset = end;
    }
    return await read(path);
  } finally {
    const removed = await execShell(['-c', 'rm -f -- "$1"', 'devkits-diff-ignore', path], { on });
    if (removed.code !== 0) throw new Error(removed.stderr || 'Cannot remove temporary build filters.');
  }
}
