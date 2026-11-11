import { exec, shared, setShared } from 'herdr';
import { projectKey } from './components/extension-contract.js';

const validAccount = account => account && typeof account.host === 'string' && typeof account.login === 'string'
  && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(account.host)
  && /^[a-z0-9][a-z0-9_.-]*$/i.test(account.login);
const key = 'herdr-zed.git-accounts';
const authorKey = 'herdr-zed.git-account-authors';
// The shell reads this envelope (ARCHITECTURE §3.5). Tokens never enter it; only the inline helper does.
export const CREDENTIALS_KEY = 'herdr-zed.git-credentials.github';
const accountAuthorKey = (account, on) => JSON.stringify([on || '', account.host.toLowerCase(), account.login.toLowerCase()]);

export function rememberGitAuthor(account, on, author) {
  if (!validAccount(account)) throw new Error('Invalid GitHub account.');
  setShared(authorKey, { ...(shared(authorKey) || {}),
    [accountAuthorKey(account, on)]: { name: author.name.trim(), email: author.email.trim() } });
}

/** Public profile metadata only; never switch accounts or transfer tokens into mod state. */
export async function readAccountAuthor(account, on) {
  if (!validAccount(account)) throw new Error('Invalid GitHub account.');
  const saved = shared(authorKey)?.[accountAuthorKey(account, on)];
  if (typeof saved?.name === 'string' && saved.name && typeof saved.email === 'string' && saved.email)
    return { name: saved.name, email: saved.email };
  const result = await exec('gh', ['api', `users/${account.login}`, '--hostname', account.host,
    '--jq', '{login,name,email}'], { on });
  if (result.code !== 0) throw new Error('Could not load the GitHub profile. Enter the commit author below.');
  let profile;
  try { profile = JSON.parse(result.stdout); } catch { throw new Error('Could not read the GitHub profile. Enter the commit author below.'); }
  if (typeof profile?.login !== 'string' || profile.login.toLowerCase() !== account.login.toLowerCase())
    throw new Error('GitHub profile does not match the selected account. Enter the commit author below.');
  return { name: typeof profile.name === 'string' && profile.name.trim() ? profile.name.trim() : account.login,
    email: typeof profile.email === 'string' ? profile.email.trim() : '' };
}

export function gitAccount(project) {
  const account = shared(key)?.[projectKey(project?.machine, project?.folder)];
  return validAccount(account) ? { host: account.host, login: account.login } : null;
}

export function setGitAccount(project, account) {
  if (account && !validAccount(account)) throw new Error('Invalid GitHub account.');
  const accounts = { ...(shared(key) || {}) };
  if (account) accounts[projectKey(project?.machine, project?.folder)] = { host: account.host, login: account.login };
  else delete accounts[projectKey(project?.machine, project?.folder)];
  setShared(key, accounts);
  publishGitCredentials();
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

/** `[key, value]` pairs applied to one Git command, in order. Only this host is affected. */
export function gitCredentialConfig(account) {
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
  return [[`credential.https://${host}.helper`, ''], [`credential.https://${host}.helper`, helper],
    [`credential.https://${host}.username`, login],
    [`url.https://${host}/.insteadOf`, `git@${host}:`], [`url.https://${host}/.insteadOf`, `ssh://git@${host}/`]];
}

/** Apply credentials to this process and host only, without switching gh's active account. */
export function gitAuthArgs(account) {
  return gitCredentialConfig(account).flatMap(([name, value]) => ['-c', `${name}=${value}`]);
}

/** Rebuilds the shared binding from the saved account choices. Writes only when a binding actually changed. */
export function publishGitCredentials() {
  const repositories = {};
  for (const [scope, account] of Object.entries(shared(key) || {})) {
    if (!validAccount(account)) continue;
    repositories[scope] = { host: account.host, login: account.login, config: gitCredentialConfig(account) };
  }
  const current = shared(CREDENTIALS_KEY);
  if (JSON.stringify(current?.repositories || {}) === JSON.stringify(repositories)) return;
  setShared(CREDENTIALS_KEY, { updatedAt: Date.now(), repositories });
}
