import { execFileSync } from 'node:child_process';
import { copyFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Herdr ships its native API types with the installed app. Copy them (never edit them) and run tsc.
const home = process.env.HERDR_APP_HOME || join(homedir(), '.config/herdr-app');
const types = fileURLToPath(new URL('./types/herdr/', import.meta.url));
await mkdir(types, { recursive: true });
for (const name of ['herdr.d.ts', 'gpui-kit.d.ts']) await copyFile(join(home, name), join(types, name));
execFileSync(process.execPath, [fileURLToPath(new URL('./node_modules/typescript/bin/tsc', import.meta.url)), '-p', 'tsconfig.json'], { stdio: 'inherit' });
