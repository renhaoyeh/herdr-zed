import { exec } from 'herdr';
import { gitShellCommand } from './components/session-shell.js';

// Same fallback as the shell's execShell: Git for Windows' bundled shell when `sh` is not usable on the machine.
const gitShellMachines = new Set();
async function execShell(args, options = {}) {
  const machine = options.on || null;
  if (!gitShellMachines.has(machine)) {
    try { return await exec('sh', args, options); }
    catch { gitShellMachines.add(machine); }
  }
  const [command, ...shellArgs] = gitShellCommand(args);
  return exec(command, shellArgs, options);
}

// Repository-local commit author, as the shell's Commit author dialog reads and writes it.
export async function readGitAuthor(folder, on) {
  const values = await Promise.all(['user.name', 'user.email'].map(async key => {
    const result = await execShell(['-c', 'cd "$1" || exit 2; git rev-parse --git-dir >/dev/null || exit 3; git config --null --get "$2"; a=$?; [ "$a" = 1 ] && exit 0; exit "$a"', 'herdr-zed-git-author', folder, key], { on });
    if (result.code !== 0) throw new Error(result.stderr.trim() || 'Cannot read commit author.');
    return result.stdout.replace(/\0$/, '');
  }));
  return { name: values[0], email: values[1] };
}

export async function saveGitAuthor(folder, on, author) {
  const name = author.name.trim(), email = author.email.trim();
  if (!name || !email || /[\0\r\n<>]/.test(name + email)) throw new Error('Enter a name and email without line breaks or angle brackets.');
  const result = await execShell(['-c', 'cd "$1" || exit 2; git config --local --replace-all user.name "$2" && git config --local --replace-all user.email "$3"', 'herdr-zed-git-author', folder, name, email], { on });
  if (result.code !== 0) throw new Error(result.stderr.trim() || 'Cannot save commit author. Check repository configuration before retrying.');
}
