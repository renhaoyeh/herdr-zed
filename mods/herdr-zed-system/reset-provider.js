// Finite cleanup for generated SYSTEM binaries; no project or account access.
import { lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export async function resetSystem(cache = join(tmpdir(), `herdr-zed-smc-${process.getuid?.() || 0}-${process.arch}`)) {
  const stat = await lstat(cache).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (stat?.isSymbolicLink()) throw new Error('Remove the symbolic link before resetting the sensor cache.');
  if (stat && (process.getuid === undefined || stat.uid === process.getuid())) await rm(cache, { recursive: true, force: true });
}
if (process.argv[2] === 'clear' && process.argv[4] === 'HERDR ZED') {
  try { await resetSystem(); console.log('{}'); } catch (error) { console.error(error.message); process.exitCode = 1; }
} else if (process.argv[2] === 'inspect') console.log('{}');
