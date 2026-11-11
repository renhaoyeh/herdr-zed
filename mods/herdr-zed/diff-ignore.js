import { appHome, readTextFile, writeTextFile } from 'herdr';
import { execShell } from './shell.js';

const DEFAULT_TEMPLATES = ['VisualStudio.gitignore', 'Qt.gitignore', 'C++.gitignore', 'CMake.gitignore', 'Node.gitignore', 'Python.gitignore'];
// Lockfiles start as ordinary Custom rules, so like every rule here they hide only untracked files.
const DEFAULT_CUSTOM = `# Lock files
*.lock
lock.json
*-lock.json
lock.yaml
*-lock.yaml
lock.yml
*-lock.yml
npm-shrinkwrap.json
bun.lockb
`;

const templatePath = file => `${appHome()}/mods/herdr-zed/assets/gitignore/${file}`;
/** Git reads this generated file; the filters file is the editable source. */
export const buildRulesPath = () => `${appHome()}/data/devkits/diff-build-output.gitignore`;
export const buildFiltersPath = () => `${appHome()}/data/devkits/diff-build-filters.json`;

/** Bundled github/gitignore templates, in provenance order. */
export async function readBuildTemplates() {
  const sources = await readTextFile(templatePath('sources.json'));
  if (sources === null) throw new Error('Build filter templates are missing.');
  const files = JSON.parse(sources).files.map(entry => entry.file).filter(file => file.endsWith('.gitignore'));
  const texts = await Promise.all(files.map(file => readTextFile(templatePath(file))));
  if (texts.some(text => text === null)) throw new Error('Build filter templates are missing.');
  return files.map((file, i) => ({ file, label: file.replace(/\.gitignore$/, ''), text: texts[i] }));
}

const normalize = (value, templates) => {
  const chosen = new Set(Array.isArray(value?.templates) ? value.templates : []);
  return { templates: templates.map(entry => entry.file).filter(file => chosen.has(file)),
    custom: typeof value?.custom === 'string' ? value.custom : '' };
};

export const serializeBuildFilters = filters => JSON.stringify(filters, null, 2) + '\n';

/** Saved filters, created with the default templates and lockfile rules when missing. `original` is the on-disk revision for saving. */
export async function readBuildFilters(templates) {
  templates ||= await readBuildTemplates();
  const path = buildFiltersPath();
  let original = await readTextFile(path);
  if (original === null) {
    const initial = serializeBuildFilters({ templates: DEFAULT_TEMPLATES, custom: DEFAULT_CUSTOM });
    try { await writeTextFile(path, initial, null); original = initial; }
    catch (error) {
      original = await readTextFile(path);
      if (original === null) throw error;
    }
  }
  let value;
  try { value = JSON.parse(original); } catch { throw new Error(`Cannot read ${path}: invalid JSON.`); }
  return { path, original, templates, filters: normalize(value, templates) };
}

export function composeBuildRules(templates, filters) {
  const chosen = templates.filter(entry => filters.templates.includes(entry.file));
  return '# Herdr display filter for untracked files, generated from Build filter rules. Edit it there.\n\n'
    + chosen.map(entry => `# github/gitignore/${entry.file}\n${entry.text}\n`).join('\n')
    + '\n# Custom rules and exceptions\n' + filters.custom;
}

/** Compose checked templates and custom rules, refreshing the generated file Git reads when it differs. */
export async function readBuildRules() {
  const { filters, templates } = await readBuildFilters();
  const path = buildRulesPath(), text = composeBuildRules(templates, filters);
  const current = await readTextFile(path);
  if (current !== text) {
    try { await writeTextFile(path, text, current); }
    catch (error) { if (await readTextFile(path) !== text) throw error; }
  }
  return { path: path.replaceAll('\\', '/'), text };
}

/** Local Git reads the saved file directly. Remote Git gets a short-lived copy in its temp folder. */
export async function withBuildRulesFile(rules, on, read) {
  if (!rules) return read('');
  if (!on) return read(rules.path);
  const created = await execShell(['-c', 'mktemp "${TMPDIR:-/tmp}/herdr-zed-diff-ignore.XXXXXX"'], { on });
  const path = created.stdout.trim();
  if (created.code !== 0 || !/(?:^|\/)herdr-zed-diff-ignore\.[A-Za-z0-9]+$/.test(path)) throw new Error('Cannot prepare remote build filters.');
  try {
    // Bound each command line, including on Windows; filenames never enter shell code.
    for (let offset = 0; offset < rules.text.length;) {
      let end = Math.min(offset + 4096, rules.text.length);
      if (end < rules.text.length && /[\ud800-\udbff]/.test(rules.text[end - 1])) end--;
      const result = await execShell(['-c', 'printf "%s" "$2" >> "$1"', 'herdr-zed-diff-ignore', path,
        rules.text.slice(offset, end)], { on });
      if (result.code !== 0) throw new Error(result.stderr || 'Cannot copy build filters.');
      offset = end;
    }
    return await read(path);
  } finally {
    const removed = await execShell(['-c', 'rm -f -- "$1"', 'herdr-zed-diff-ignore', path], { on });
    if (removed.code !== 0) throw new Error(removed.stderr || 'Cannot remove temporary build filters.');
  }
}
