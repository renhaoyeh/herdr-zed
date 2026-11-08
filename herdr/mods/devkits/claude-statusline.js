// Compatibility entry for Claude sessions that already loaded this status-line command.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStatusLine } from '../devkits-usage/claude-statusline.js';
export { statusText, record, chained } from '../devkits-usage/claude-statusline.js';
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runStatusLine();
