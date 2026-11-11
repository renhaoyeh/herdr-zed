// Runs outside GPUI so each CLI owns authentication and credential refresh.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isMain } from '../node-main.js';
import { commandArgv } from '../components/session-shell.js';

export const claudeUsageFile = 'devkits-usage.json';
const claudeLimits = [['five_hour', '5-hour', 300], ['seven_day', 'Weekly', 10080]];

// Maps the rate_limits object Claude Code passes to its status line.
export function claudeUsageWindows(limits = {}) {
  return claudeLimits.flatMap(([slot, name, minutes]) => {
    const window = limits?.[slot];
    if (!window || !Number.isFinite(window.used_percentage)) return [];
    return [{ bucket: 'claude', name, slot, minutes, usedPercent: Math.max(0, Math.min(100, window.used_percentage)),
      resetsAt: Number.isFinite(window.resets_at) && window.resets_at > 0 ? window.resets_at : null }];
  });
}

export const claudeConfigDir = run => Array.isArray(run)
  ? run.find(arg => arg.startsWith('CLAUDE_CONFIG_DIR='))?.slice('CLAUDE_CONFIG_DIR='.length) || null : null;

// Claude Code keeps the signed-in account's plan in its profile file (not its credentials):
// claude_pro, or claude_max with a 5x/20x rate-limit tier.
export function claudePlan(profile) {
  const account = profile?.oauthAccount, type = account?.organizationType;
  if (typeof type !== 'string' || !type) return null;
  const tier = /max_(\d+)x/.exec(`${account.organizationRateLimitTier || ''} ${account.userRateLimitTier || ''}`)?.[1];
  return type === 'claude_max' && tier ? `claude_max_${tier}x` : type;
}

// The signed-in address from the same profile file, so a Default account can be told apart.
export const claudeEmail = profile => typeof profile?.oauthAccount?.emailAddress === 'string' && profile.oauthAccount.emailAddress || null;

// Reads only what this profile's status line recorded and its account plan; it never touches credentials or the network.
export async function readClaudeUsage(run, home = homedir()) {
  const configured = claudeConfigDir(run), directory = configured || `${home}/.claude`;
  let saved, profile;
  try { saved = JSON.parse(await readFile(`${directory}/${claudeUsageFile}`, 'utf8')); } catch {}
  try { profile = JSON.parse(await readFile(configured ? `${directory}/.claude.json` : `${home}/.claude.json`, 'utf8')); } catch {}
  if (!saved?.rate_limits) throw Object.assign(new Error('No usage yet. Start a session with this account to update it.'), { email: claudeEmail(profile), plan: claudePlan(profile) });
  const plan = claudePlan(profile);
  return { email: claudeEmail(profile), windows: claudeUsageWindows(saved.rate_limits), fetchedAt: Number.isFinite(saved.capturedAt) ? saved.capturedAt : null,
    ...(plan ? { plan } : {}) };
}

export function usageWindows(result = {}) {
  const buckets = result.rateLimitsByLimitId;
  return Object.entries(buckets && Object.keys(buckets).length ? buckets : { codex: result.rateLimits })
    .flatMap(([bucket, value]) => ['primary', 'secondary'].flatMap(slot => {
      const window = value?.[slot];
      if (!window || !Number.isFinite(window.usedPercent)) return [];
      return [{ bucket, name: value.limitName || bucket, slot,
        minutes: Number.isFinite(window.windowDurationMins) && window.windowDurationMins > 0 ? window.windowDurationMins : null,
        usedPercent: Math.max(0, Math.min(100, window.usedPercent)),
        resetsAt: Number.isFinite(window.resetsAt) ? window.resetsAt : null }];
    }));
}

export const readUsage = async (argv, timeout) => (await readCodexUsage(argv, timeout)).windows;

// Codex reports the account's plan (plus, team, prolite, pro, ...) with its rate limits.
export function readCodexUsage(argv, timeout = 18000) {
  return new Promise((resolve, reject) => {
    const args = commandArgv(argv.filter(arg => arg !== '--no-daemon'), process.platform === 'win32' ? 'windows' : process.platform);
    const child = spawn(args[0], [...args.slice(1), 'app-server'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    const lines = createInterface({ input: child.stdout });
    let done = false, limits, email = null, accountTimer;
    const finish = (error, result) => {
      if (done) return;
      done = true;
      clearTimeout(timer); clearTimeout(accountTimer);
      lines.close();
      child.stdin.end();
      const kill = setTimeout(() => child.kill('SIGKILL'), 800);
      kill.unref();
      child.once('close', () => clearTimeout(kill));
      if (error) reject(new Error(error));
      else resolve({ windows: usageWindows(result), plan: typeof result.rateLimits?.planType === 'string' ? result.rateLimits.planType : null,
        email: typeof email === 'string' && email || null });
    };
    const timer = setTimeout(() => finish('Usage request timed out'), timeout);
    const send = message => { if (!done) child.stdin.write(`${JSON.stringify(message)}\n`); };
    child.on('error', () => finish('Cannot start Codex'));
    child.on('close', () => finish('Codex closed before returning usage'));
    child.stdin.on('error', () => finish('Cannot communicate with Codex'));
    lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id === 1) {
        if (message.error) return finish('Codex initialization failed');
        send({ method: 'initialized' });
        send({ id: 2, method: 'account/rateLimits/read' });
      } else if (message.id === 2) {
        if (message.error) return finish('Usage unavailable; check account sign-in');
        // The signed-in address is optional; usage stands without it.
        limits = message.result || {};
        accountTimer = setTimeout(() => finish(null, limits), 2000);
        send({ id: 3, method: 'account/read', params: { refreshToken: false } });
      } else if (message.id === 3) {
        email = message.result?.account?.email;
        finish(null, limits);
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'devkits_usage', version: '0.1.0' } } });
  });
}

if (await isMain(import.meta.url)) {
  const accounts = JSON.parse(process.argv[2]);
  console.log(JSON.stringify(await Promise.all(accounts.map(async account => {
    try {
      if (account.provider === 'claude') return { key: account.key, name: account.name, ...await readClaudeUsage(account.run) };
      return { key: account.key, name: account.name, ...await readCodexUsage(account.run), fetchedAt: Date.now() };
    }
    catch (error) { return { key: account.key, name: account.name, error: error.message, ...(error.email ? { email: error.email } : {}), ...(error.plan ? { plan: error.plan } : {}) }; }
  }))));
}
