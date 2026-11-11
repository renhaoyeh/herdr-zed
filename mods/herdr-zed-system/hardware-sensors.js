import { readFile, mkdir, lstat, access, mkdtemp, rename, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export async function readMacSensors({ cacheRoot = join(tmpdir(), `herdr-zed-smc-${process.getuid?.() || 0}-${process.arch}`) } = {}, run = execute) {
  try {
    const source = new URL('./hardware-smc.c', import.meta.url);
    const hash = createHash('sha256').update(await readFile(source)).digest('hex').slice(0, 20);
    await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
    const folder = await lstat(cacheRoot);
    if (!folder.isDirectory() || folder.isSymbolicLink() || folder.uid !== process.getuid()) throw new Error('Sensor cache unavailable');
    const binary = join(cacheRoot, `reader-${hash}`);
    let ready = false;
    try {
      const info = await lstat(binary);
      ready = info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid();
      if (ready) await access(binary, constants.X_OK);
    } catch { ready = false; }
    if (!ready) {
      // Check CLT availability first. Never invoke an installer or request elevation.
      try { await run('/usr/bin/xcode-select', ['-p'], { timeout: 1500 }); }
      catch { return { sensors: [], sensorStatus: 'Apple Command Line Tools are needed to build the local sensor reader.' }; }
      const build = await mkdtemp(join(cacheRoot, 'build-'));
      try {
        const output = join(build, 'reader');
        await run('/usr/bin/xcrun', ['--sdk', 'macosx', 'clang', '-std=c11', '-O2', fileURLToPath(source), '-framework', 'IOKit', '-framework', 'CoreFoundation', '-o', output], { timeout: 10000 });
        await rename(output, binary);
      } finally { await rm(build, { recursive: true, force: true }); }
    }
    const result = await run(binary, [], { timeout: 1500, maxBuffer: 1024 * 1024 });
    const sensors = JSON.parse(result.stdout);
    if (!Array.isArray(sensors)) throw new Error('Sensor data unavailable');
    return { sensors, sensorStatus: sensors.length ? null : 'This Mac did not return supported SMC readings.' };
  } catch { return { sensors: [], sensorStatus: 'The native sensor reader is unavailable on this Mac.' }; }
}
