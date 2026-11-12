// Lists the user's own Rules and Skills: node capabilities-scan.js <capabilities folder>
// Prints {"rules": [paths of rules/*.md], "skills": [paths of skills/<name>/SKILL.md]}; a missing folder lists nothing.
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2];
const entries = folder => { try { return readdirSync(folder, { withFileTypes: true }); } catch { return []; } };
const rules = entries(join(root, 'rules')).filter(entry => entry.isFile() && /\.md$/i.test(entry.name))
  .map(entry => join(root, 'rules', entry.name)).sort();
const skills = entries(join(root, 'skills')).filter(entry => entry.isDirectory())
  .map(entry => join(root, 'skills', entry.name, 'SKILL.md')).filter(path => existsSync(path)).sort();
process.stdout.write(JSON.stringify({ rules, skills }));
