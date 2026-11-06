import { exec, shared, setShared } from 'herdr';

const validAccount = account => account && typeof account.host === 'string' && typeof account.login === 'string'
  && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(account.host)
  && /^[a-z0-9][a-z0-9_.-]*$/i.test(account.login);
const projectKey = project => JSON.stringify([project?.machine || '', project?.folder || '']);
const key = 'devkits.git-accounts';

export function gitAccount(project) {
  const account = shared(key)?.[projectKey(project)];
  return validAccount(account) ? { host: account.host, login: account.login } : null;
}

export function setGitAccount(project, account) {
  if (account && !validAccount(account)) throw new Error('Invalid GitHub account.');
  const accounts = { ...(shared(key) || {}) };
  if (account) accounts[projectKey(project)] = { host: account.host, login: account.login };
  else delete accounts[projectKey(project)];
  setShared(key, accounts);
}

export async function readGitAccounts(on) {
  // Select public metadata in gh itself; credentials never enter the mod's state.
  const result = await exec('gh', ['auth', 'status', '--json', 'hosts', '--jq',
    '[.hosts[][] | {host,login,state}]'], { on });
  if (result.code !== 0) throw new Error('Cannot read GitHub accounts. Run gh auth login on this machine, then retry.');
  let accounts;
  try { accounts = JSON.parse(result.stdout); } catch { throw new Error('Cannot read GitHub accounts. Update gh and retry.'); }
  if (!Array.isArray(accounts)) throw new Error('Cannot read GitHub accounts. Update gh and retry.');
  return accounts.filter(validAccount).map(({ host, login, state }) => ({ host, login, available: state === 'success' }));
}

/** Apply credentials to this process and host only, without switching gh's active account. */
export function gitAuthArgs(account) {
  if (!account) return [];
  if (!validAccount(account)) throw new Error('Invalid GitHub account.');
  const { host, login } = account;
  const helper = '!f() { [ "$1" = get ] || return 0; '
    + 'protocol=; host=; while IFS= read -r line && [ -n "$line" ]; do '
    + 'case "$line" in protocol=*) protocol=${line#protocol=};; host=*) host=${line#host=};; esac; done; '
    + `[ "$protocol" = https ] && [ "$host" = '${host}' ] || return 0; `
    + 'unset GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN; '
    + `token=$(gh auth token --hostname '${host}' --user '${login}') || { printf 'quit=true\\n'; return 1; }; `
    + `[ -n "$token" ] || { printf 'quit=true\\n'; return 1; }; printf 'username=%s\\npassword=%s\\n' '${login}' "$token"; }; f`;
  return ['-c', `credential.https://${host}.helper=`, '-c', `credential.https://${host}.helper=${helper}`,
    '-c', `credential.https://${host}.username=${login}`,
    '-c', `url.https://${host}/.insteadOf=git@${host}:`,
    '-c', `url.https://${host}/.insteadOf=ssh://git@${host}/`];
}
