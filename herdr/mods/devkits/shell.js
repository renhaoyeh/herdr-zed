import { exec } from 'herdr';

const gitShellMachines = new Set();

export async function execShell(args, options = {}) {
  const machine = options.on || null;
  if (!gitShellMachines.has(machine)) {
    try { return await exec('sh', args, options); }
    catch { gitShellMachines.add(machine); }
  }
  // Git for Windows sets up its bundled shell and Unix tools without changing the user's PATH.
  return exec('git', ['-c', 'alias.devkits-shell=!sh', 'devkits-shell', ...args], options);
}
