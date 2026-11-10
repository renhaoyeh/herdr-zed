import { execShell } from './shell.js';

/** Read effective values, including inherited global and conditional configuration. */
export async function readGitAuthor(folder, on) {
  const values = await Promise.all(['user.name', 'user.email'].map(async key => {
    const result = await execShell(['-c', 'cd "$1" || exit 2; git rev-parse --git-dir >/dev/null || exit 3; '
      + 'git config --null --get "$2"; a=$?; [ "$a" = 1 ] && exit 0; exit "$a"',
    'devkits-git-author', folder, key], { on });
    if (result.code !== 0) throw new Error(result.stderr.trim() || 'Cannot read commit author.');
    return result.stdout.replace(/\0$/, '');
  }));
  return { name: values[0], email: values[1] };
}

export async function saveGitAuthor(folder, on, author) {
  const name = author.name.trim(), email = author.email.trim();
  if (!name || !email || /[\0\r\n<>]/.test(name + email))
    throw new Error('Enter a name and email without line breaks or angle brackets.');
  const result = await execShell(['-c', 'cd "$1" || exit 2; '
    + 'git config --local --replace-all user.name "$2" && git config --local --replace-all user.email "$3"',
  'devkits-git-author', folder, name, email], { on });
  if (result.code !== 0) throw new Error(result.stderr.trim() || 'Cannot save commit author. Check repository configuration before retrying.');
}
