// Shell side of ARCHITECTURE §3.5: apply the active gitCredentials provider's binding for one repository.
// The shell never knows what provides it; a violation drops the whole binding and Git runs without it.
import { gitCredentialArgs, projectKey } from './components/extension-contract.js';

/**
 * Returns ['-c', 'key=value', …] for the repository, or [] when there is no provider or no binding for it.
 * `read(key)` returns a shared value; `report(message)` is called once per invalid binding.
 */
/** The repository's bound account `{ host, login }` for display, or null; an invalid binding shows nothing. */
export function credentialAccountFor(provider, repository, read) {
  if (!provider) return null;
  const binding = read(`herdr-zed.git-credentials.${provider.id}`)?.repositories?.[projectKey(repository.machine, repository.folder)];
  if (!binding) return null;
  try { gitCredentialArgs(binding); return { host: binding.host, login: binding.login }; } catch { return null; }
}

export function credentialArgsFor(provider, repository, read, report) {
  if (!provider) return [];
  const envelope = read(`herdr-zed.git-credentials.${provider.id}`);
  const binding = envelope?.repositories?.[projectKey(repository.machine, repository.folder)];
  if (!binding) return [];
  try { return gitCredentialArgs(binding); }
  catch (error) { report(error.message); return []; }
}
