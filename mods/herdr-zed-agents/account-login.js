import { Input } from './components/input.js';
import { ensureClaudeStatusLine } from './components/claude-usage-hook.js';
import { div } from 'gpui-kit';
import { v_flex, h_flex, InputState } from 'gpui-base';
import { WebSocket } from 'websocket';
import { appHome, exec, hc, readTextFile, writeTextFile, theme, closeOverlay, run, window, shared, setShared } from 'herdr';
import { commandArgv } from './components/session-shell.js';
import { launcherLabel } from './components/session-model.js';
import { Button } from './components/button.js';

// Each account owns a private credentials directory; the CLI itself signs in, stores, and refreshes tokens.
export const accountProviders = {
  codex: {
    label: 'Codex', service: 'ChatGPT', icon: 'icons/codex.svg', launch: ['--no-daemon'], logout: ['logout'],
    home: directory => [`CODEX_HOME=${directory}`],
    command: directory => ['env', '-u', 'OPENAI_API_KEY', '-u', 'CODEX_API_KEY', '-u', 'CODEX_ACCESS_TOKEN',
      `CODEX_HOME=${directory}`, 'codex', '-c', 'cli_auth_credentials_store="file"'],
  },
  claude: {
    label: 'Claude', service: 'Claude', icon: 'icons/claude.svg', launch: [], logout: ['auth', 'logout'],
    // Claude Code 2.1.144+ scopes macOS Keychain credentials to this directory as well.
    home: directory => [`CLAUDE_CONFIG_DIR=${directory}`, `CLAUDE_SECURESTORAGE_CONFIG_DIR=${directory}`],
    command: directory => ['env', '-u', 'ANTHROPIC_API_KEY', '-u', 'ANTHROPIC_AUTH_TOKEN', '-u', 'CLAUDE_CODE_OAUTH_TOKEN',
      `CLAUDE_CONFIG_DIR=${directory}`, `CLAUDE_SECURESTORAGE_CONFIG_DIR=${directory}`, 'claude'],
  },
};

const keyPattern = /^devkits-(codex|claude)-([a-zA-Z0-9][a-zA-Z0-9_-]{0,47})$/;
export const accountLabel = launcherLabel;

function provider(id) {
  if (!Object.hasOwn(accountProviders, id)) throw new Error('Unsupported account provider.');
  return accountProviders[id];
}

function accountName(name) {
  name = name.trim();
  if (!name || Array.from(name).length > 48 || /[\u0000-\u001f\u007f-\u009f]/.test(name)) {
    throw new Error('Use 1–48 characters without control characters. Chinese and uppercase names are welcome.');
  }
  return name;
}

export function accountProfile(providerId, name, root, id) {
  const source = provider(providerId);
  name = accountName(name);
  if (!/^account-[a-zA-Z0-9]{12}$/.test(id || '')) throw new Error(`Invalid ${source.label} account ID.`);
  const directory = `${root}/data/devkits/${providerId}/${id}`;
  return { provider: providerId, name, directory, key: `devkits-${providerId}-${id}`,
    run: commandArgv(source.command(directory), window()?.platform) };
}

// Windows tools may print `\` or `/c/` for the same folder; drive paths are case-insensitive.
function samePath(path) {
  path = path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/([a-zA-Z])\//, '$1:/');
  return /^[a-zA-Z]:\//.test(path) ? path.toLowerCase() : path;
}

function hasAccountName(data, label) {
  return Object.values(data.programs || {}).some(program => program?.name === label);
}

function programs(source) {
  const data = source === null ? {} : JSON.parse(source);
  if (!data || typeof data !== 'object' || Array.isArray(data) ||
      (data.programs !== undefined && (!data.programs || typeof data.programs !== 'object' || Array.isArray(data.programs)))) {
    throw new Error('Herdr programs.json must contain a programs object.');
  }
  return data;
}

export async function registerAccount(profile) {
  const source = provider(profile.provider);
  const path = `${appHome()}/programs.json`;
  const text = await readTextFile(path);
  const data = programs(text);
  const label = `${source.label} · ${profile.name}`;
  if (Object.hasOwn(data.programs || {}, profile.key) || hasAccountName(data, label)) {
    throw new Error('That account name is already in the agent menu. Choose another name.');
  }
  data.programs = { ...data.programs, [profile.key]: {
    name: label, icon: source.icon, tint: false, run: [...profile.run, ...source.launch],
  } };
  // Compare-and-swap keeps concurrent settings edits from being overwritten.
  await writeTextFile(path, `${JSON.stringify(data, null, 2)}\n`, text);
}

export async function renameAccountProfile(key, name) {
  name = accountName(name);
  const match = keyPattern.exec(key || '');
  if (!match) throw new Error('Only saved accounts can be renamed.');
  const path = `${appHome()}/programs.json`;
  const source = await readTextFile(path);
  const data = programs(source);
  const entry = data.programs?.[key];
  if (!entry) throw new Error('This account no longer exists. Reopen Manage and try again.');
  const label = `${provider(match[1]).label} · ${name}`;
  if (Object.entries(data.programs).some(([other, value]) => other !== key && value?.name === label)) {
    throw new Error('That account name is already in the agent menu. Choose another name.');
  }
  data.programs[key] = { ...entry, name: label };
  await writeTextFile(path, `${JSON.stringify(data, null, 2)}\n`, source);
}

export async function removeAccountProfile(key) {
  const match = keyPattern.exec(key || '');
  if (!match) throw new Error('Only Devkits accounts can be removed.');
  const source = provider(match[1]);
  const directory = `${appHome()}/data/devkits/${match[1]}/${match[2]}`;
  const home = source.home(directory)[0];
  const path = `${appHome()}/programs.json`;
  const data = programs(await readTextFile(path));
  const entry = data.programs?.[key];
  if (!Array.isArray(entry?.run) || !entry.run.includes(home)) {
    throw new Error('This account does not use its own Devkits credentials directory. Nothing was changed.');
  }
  if (Object.entries(data.programs).some(([other, value]) => other !== key && Array.isArray(value?.run) && value.run.includes(home))) {
    throw new Error('Another entry shares this account’s credentials. Nothing was changed.');
  }
  const [command, ...args] = commandArgv(source.command(directory), window()?.platform);
  const result = await exec(command, [...args, ...source.logout]);
  if (result.code !== 0) throw new Error('Could not sign out. The account entry was kept.');
  try {
    const text = await readTextFile(path);
    const latest = programs(text);
    if (!Object.hasOwn(latest.programs || {}, key)) return;
    if (JSON.stringify(latest.programs[key]) !== JSON.stringify(entry)) throw new Error('Account settings changed.');
    delete latest.programs[key];
    await writeTextFile(path, `${JSON.stringify(latest, null, 2)}\n`, text);
  } catch {
    throw new Error('Signed out, but could not remove the account entry. Reload Manage and retry.');
  }
}

export default class AccountLogin {
  init(target, cx) {
    this.target = target;
    this.provider = Object.hasOwn(accountProviders, target?.provider) ? target.provider : 'codex';
    this.phase = 'name';
    this.input = InputState.new({ placeholder: 'e.g. 工作帳號 or Personal' });
    this.input.on('submit', (_event, cx) => this.start(cx));
    this.codeInput = InputState.new({ placeholder: 'Authentication code' });
    this.codeInput.on('submit', (_event, cx) => this.sendCode(cx));
    this.callbackInput = InputState.new({ placeholder: 'http://localhost:1455/auth/callback?…' });
    this.callbackInput.on('submit', (_event, cx) => this.submitCallback(cx));
    this.handle = cx.focus_handle();
    this.input.focus();
  }

  get source() { return accountProviders[this.provider || 'codex']; }

  async request(method, params) {
    const id = ++this.nextId;
    await this.socket.write(JSON.stringify({ id, method, params }));
    for (;;) {
      const message = JSON.parse(await this.socket.read());
      if (message.id === id) {
        if (message.error) throw new Error(message.error.message || 'Codex could not complete this request.');
        return message.result;
      }
      if (message.method === 'account/login/completed') this.completed.push(message.params);
    }
  }

  async stop() {
    this.stopped = true;
    this.timeout?.cancel();
    const terminal = this.terminal;
    const socket = this.socket;
    this.terminal = null;
    this.socket = null;
    await Promise.allSettled([
      ...(terminal ? [hc(['kill', terminal])] : []),
      ...(socket ? [socket.close()] : []),
    ]);
  }

  async close() {
    this.closed = true;
    await this.stop();
  }

  armTimeout(cx, ms) {
    this.timeout?.cancel();
    this.timeout = cx.timer.after(ms, cx => {
      this.error = 'Sign-in timed out. Please try again.';
      this.phase = 'error';
      cx.spawn(async cx => { await this.stop(); cx.notify(); });
    });
  }

  waiting(cx) {
    this.phase = 'waiting';
    this.armTimeout(cx, 600000);
    if (this.provider === 'claude') this.codeInput.focus();
    cx.notify();
  }

  start(cx) {
    if (this.busy || this.phase === 'success') return;
    let name;
    try { name = accountName(this.input.value()); }
    catch (error) { this.error = error.message; cx.notify(); return; }
    const source = this.source;
    this.busy = true;
    this.stopped = false;
    this.error = null;
    this.authUrl = null;
    this.linkCopied = false;
    this.phase = 'connecting';
    this.nextId = 0;
    this.completed = [];
    this.armTimeout(cx, 20000);
    cx.spawn(async cx => {
      try {
        const current = programs(await readTextFile(`${appHome()}/programs.json`));
        if (this.closed || this.stopped) return;
        if (hasAccountName(current, `${source.label} · ${name}`)) {
          throw new Error('That account name is already in the agent menu. Choose another name.');
        }
        if (!this.profile) {
          const root = appHome();
          const parent = `${root}/data/devkits/${this.provider}`;
          // Atomically allocate an ID so even case-insensitive filesystems keep accounts separate.
          const allocated = await exec('node', ['-e', 'const fs = require("node:fs"), path = require("node:path"); '
            + 'const parent = process.argv[1]; fs.mkdirSync(parent, { recursive: true, mode: 0o700 }); '
            + 'const directory = path.join(parent, "account-" + require("node:crypto").randomBytes(6).toString("hex")); '
            + 'fs.mkdirSync(directory, { mode: 0o700 }); console.log(directory);', parent]);
          if (allocated.code !== 0) throw new Error('Could not create the account directory.');
          if (this.closed || this.stopped) return;
          const output = allocated.stdout.trim();
          const profile = accountProfile(this.provider, name, root, output.split(/[\\/]/).at(-1));
          if (samePath(output) !== samePath(profile.directory)) {
            throw new Error(`Invalid ${source.label} account directory: ${output}`);
          }
          this.profile = profile;
        }
        const profile = this.profile;
        profile.name = name;
        if (this.closed || this.stopped) return;
        const email = this.provider === 'claude' ? await this.signInClaude(profile, cx) : await this.signInCodex(profile, cx);
        if (this.closed || this.stopped) return;
        if (this.error) throw new Error(this.error);
        this.phase = 'saving';
        this.armTimeout(cx, 20000);
        cx.notify();
        if (this.provider === 'claude') {
          try { await ensureClaudeStatusLine(profile.directory); } catch {} // Usage stays unavailable; sign-in still succeeds.
        }
        await registerAccount(profile);
        // Settings stays open beneath this dialog and reloads its accounts on this revision.
        setShared('herdr-zed.agent-cache', {});
        setShared('herdr-zed.profile-revision', (shared('herdr-zed.profile-revision') || 0) + 1);
        this.phase = 'success';
        this.email = email || profile.name;
      } catch (error) {
        if (!this.closed) { this.error = this.error || error.message; this.phase = 'error'; }
      } finally {
        await this.stop();
        this.busy = false;
        if (!this.closed) cx.notify();
      }
    });
    cx.notify();
  }

  async signInCodex(profile, cx) {
    const started = await hc(['run', '--json', '--bg', '--rm', '--no-parent', '--no-notify', '--cwd', profile.directory,
      '--', ...profile.run, 'app-server', '--listen', 'ws://127.0.0.1:0']);
    if (started.code !== 0) throw new Error('Could not start Codex. Make sure Codex CLI is installed.');
    this.terminal = JSON.parse(started.stdout).address;
    if (!this.terminal) throw new Error('Codex did not return a background process.');
    if (this.closed || this.stopped) return;
    let endpoint;
    for (let attempt = 0; attempt < 50 && !this.closed && !this.stopped; attempt++) {
      const output = await hc(['read', this.terminal, '--lines', '20']);
      if (output.code !== 0) throw new Error('Codex stopped before sign-in could start. Check your Codex CLI installation.');
      endpoint = output.stdout.match(/listening on: (ws:\/\/127\.0\.0\.1:\d+)/)?.[1];
      if (endpoint) break;
      await cx.sleep(100);
    }
    if (this.closed || this.stopped) return;
    if (!endpoint) throw new Error('Codex did not become ready. Please try again.');
    this.socket = await WebSocket.connect(endpoint);
    if (this.closed || this.stopped) return;
    await this.request('initialize', { clientInfo: { name: 'devkits_herdr', title: 'Devkits', version: '0.1.0' } });
    await this.socket.write(JSON.stringify({ method: 'initialized' }));
    let { account } = await this.request('account/read', { refreshToken: true });
    if (account?.type !== 'chatgpt') {
      const login = await this.request('account/login/start', { type: 'chatgpt' });
      if (login.type !== 'chatgpt' || !login.loginId || !/^https:\/\/(auth\.openai\.com|chatgpt\.com)\//.test(login.authUrl || '')) {
        throw new Error('Codex returned an invalid sign-in response.');
      }
      this.authUrl = login.authUrl;
      this.waiting(cx);
      this.openBrowser(cx);
      for (;;) {
        const completed = this.completed.find(event => event.loginId === login.loginId);
        if (completed) {
          if (!completed.success) throw new Error(completed.error || 'Sign-in was cancelled. Please try again.');
          break;
        }
        const message = JSON.parse(await this.socket.read());
        if (message.method === 'account/login/completed') this.completed.push(message.params);
      }
      ({ account } = await this.request('account/read', { refreshToken: true }));
    }
    if (this.closed || this.stopped) return;
    if (account?.type !== 'chatgpt') throw new Error('Codex could not confirm your ChatGPT account. Please try again.');
    return account.email;
  }

  async claudeStatus(profile) {
    const [command, ...args] = profile.run;
    const result = await exec(command, [...args, 'auth', 'status', '--json']);
    try {
      const status = JSON.parse(result.stdout);
      return status?.loggedIn && status.authMethod === 'claude.ai' ? status : null;
    } catch { return null; }
  }

  async signInClaude(profile, cx) {
    // A retry after a failed save reuses credentials that are already signed in.
    let status = await this.claudeStatus(profile);
    if (status || this.closed || this.stopped) return status?.email;
    const started = await hc(['run', '--json', '--bg', '--rm', '--no-parent', '--no-notify', '--cwd', profile.directory,
      '--', ...profile.run, 'auth', 'login', '--claudeai']);
    if (started.code !== 0) throw new Error('Could not start Claude Code. Make sure Claude Code is installed.');
    this.terminal = JSON.parse(started.stdout).address;
    if (!this.terminal) throw new Error('Claude Code did not return a background process.');
    // Claude Code opens the browser itself; the printed URL is the copy-code fallback.
    for (let attempt = 0; !this.closed && !this.stopped; attempt++) {
      const output = await hc(['read', this.terminal, '--lines', '40']);
      if (output.code !== 0) {
        status = await this.claudeStatus(profile);
        if (status) return status.email;
        throw new Error('Sign-in did not complete. Please try again.');
      }
      if (!this.authUrl) {
        const url = output.stdout.match(/visit:\s*([\s\S]*?)\s*Paste code/)?.[1]?.replace(/\s+/g, '');
        if (/^https:\/\/(?:claude\.com|claude\.ai|platform\.claude\.com)\/\S+$/.test(url || '')) this.authUrl = url;
      }
      if (this.phase === 'connecting' && /Paste code/.test(output.stdout)) this.waiting(cx);
      if (/Login successful/.test(output.stdout) || attempt % 3 === 2) {
        status = await this.claudeStatus(profile);
        if (status) return status.email;
      }
      await cx.sleep(1000);
    }
  }

  sendCode(cx) {
    const code = this.codeInput.value().trim();
    if (this.phase !== 'waiting' || !this.terminal || this.sendingCode) return;
    if (!/^[A-Za-z0-9._~#-]{1,512}$/.test(code)) { this.codeError = 'Paste the code shown in your browser.'; cx.notify(); return; }
    this.sendingCode = true; this.codeError = null; cx.notify();
    cx.spawn(async cx => {
      const sent = await hc(['send', '--force', this.terminal, code]);
      this.sendingCode = false;
      if (sent.code !== 0) this.codeError = 'Could not send the code. Please try again.';
      else this.codeInput.set_value('');
      if (!this.closed) cx.notify();
    });
  }

  submitCallback(cx) {
    if (this.provider !== 'codex' || this.phase !== 'waiting' || this.submittingCallback) return;
    const callback = this.callbackInput.value().trim();
    this.submittingCallback = true; this.callbackError = null; cx.notify();
    cx.spawn(async cx => {
      try {
        // Parse and forward in Node: never open arbitrary pasted URLs or follow redirects.
        const result = await exec('node', ['-e', `
          const http = require('node:http');
          try {
            const auth = new URL(process.argv[1]), url = new URL(process.argv[2]);
            const redirect = new URL(auth.searchParams.get('redirect_uri'));
            if (url.origin !== redirect.origin || url.pathname !== redirect.pathname ||
                url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname) ||
                url.username || url.password || url.hash || !url.searchParams.get('code') ||
                !auth.searchParams.get('state') || url.searchParams.getAll('state').length !== 1 ||
                url.searchParams.get('state') !== auth.searchParams.get('state')) throw new Error();
            const request = http.get(url, response => {
              response.resume();
              response.on('end', () => process.exit(response.statusCode >= 200 && response.statusCode < 400 ? 0 : 1));
            });
            request.setTimeout(15000, () => request.destroy());
            request.on('error', () => process.exit(1));
          } catch { process.exit(2); }
        `, this.authUrl, callback]);
        if (result.code !== 0) this.callbackError = result.code === 2
          ? 'Paste the full localhost callback URL from this sign-in attempt.'
          : 'Could not complete sign-in. Check the URL and try again.';
        else this.callbackInput.set_value('');
      } catch { this.callbackError = 'Could not complete sign-in. Please try again.'; }
      this.submittingCallback = false;
      if (!this.closed) cx.notify();
    });
  }

  openBrowser(cx) {
    if (!this.authUrl) return;
    cx.open_url(this.authUrl);
  }

  finish() {
    closeOverlay(this.target.overlay);
    // Settings is opened by the shell; its Agents page reloads accounts on profile-revision.
    if (this.target.returnTo) run('herdr-zed.settings:agents');
  }

  render() {
    const t = theme();
    const source = this.source;
    const id = this.provider || 'codex';
    const pasteCode = id === 'claude' && this.phase === 'waiting';
    const pasteCallback = id === 'codex' && this.phase === 'waiting';
    const action = (name, label, handler, primary = false) => Button(`${id}-login-${name}`, t, { variant: primary ? 'default' : 'secondary' })
      .on_click(handler).child(label);
    return v_flex().id(`${id}-login-dialog`).size_full().rounded(0).border(1).border_color(t.border).p(24).gap(16).bg(t.popover).text_color(t.foreground).role('dialog')
      .track_focus(this.handle).on_key_down((event, cx) => {
        if (event.key === 'escape') { cx.stop_propagation(); this.finish(); }
        else if (event.key === 'enter' && this.phase === 'success') { cx.stop_propagation(); this.finish(); }
        else if (event.key === 'enter' && this.phase === 'waiting' && !pasteCode) { cx.stop_propagation(); this.openBrowser(cx); }
      })
      .child(v_flex().gap(6)
        .child(div().font_family('Georgia').text_size(22).font_normal().child(this.phase === 'success'
          ? `${source.label} account connected` : `Add ${source.label} account`))
        .child(div().text_size(13).text_color(t.muted).child(this.phase === 'success'
          ? `${this.email} is ready in your agent menu.` : `Connect a ${source.service} account to use with ${source.label}.`)))
      .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar().gap(10)
        .when(pasteCallback, el => el
          .child(v_flex().gap(12)
            .child(div().text_size(12).text_color(t.muted).child('This window updates when sign-in is complete.'))
            .child(h_flex().gap(8)
              .child(action('browser', 'Open browser', (_event, cx) => this.openBrowser(cx), true))
              .child(action('copy-link', this.linkCopied ? 'Link copied' : 'Copy sign-in link', (_event, cx) => {
                cx.write_to_clipboard(this.authUrl); this.linkCopied = true; cx.notify();
              }))))
          .child(v_flex().mt(4).pt(14).border_t(1).border_color(t.border).gap(10)
            .child(div().text_size(13).font_medium().child('Signing in on another computer'))
            .child(div().text_size(12).text_color(t.muted).child('Send the link, then paste the full localhost URL returned after sign-in.'))
            .child(Input.new(this.callbackInput, t).id('codex-login-callback').accessibility_label('Sign-in callback URL')
              .h(36).px(10).rounded(0).border(1).border_color(t.input).text_size(12))
            .child(div().text_size(12).text_color(t.dim).child('Copy the address even if the browser says the page cannot open.'))
            .when(Boolean(this.callbackError), el => el.child(div().text_size(12).text_color(t.destructive || t.foreground).child(this.callbackError)))
            ))
        .when(!this.busy && this.phase !== 'success', el => el
          .child(div().text_size(12).font_medium().child('Account name'))
          .child(Input.new(this.input, t).id(`${id}-account-name`))
          .child(div().text_size(12).text_color(t.muted).child('A display name. Chinese and uppercase names are welcome.')))
        .when(this.busy && !pasteCallback, el => el.child(div().text_size(13).text_color(t.muted).child(
          this.phase === 'waiting' ? `Finish signing in in your browser. This window will update automatically.${
            pasteCode ? ' If the browser shows a code, paste it below.' : ''}`
            : this.phase === 'saving' ? 'Adding your account to the agent menu…' : `Preparing ${source.label} sign-in…`)))
        .when(pasteCode, el => el
          .child(Input.new(this.codeInput, t).id('claude-login-code').accessibility_label('Authentication code')
            )
          .when(Boolean(this.codeError), el => el.child(div().text_size(12).text_color(t.destructive || t.foreground).child(this.codeError))))
        .when(Boolean(this.error), el => el.child(div().id(`${id}-login-error`).text_size(12).text_color(t.destructive || t.foreground).child(this.error))))
      .child(h_flex().flex_none().gap(8).justify_end()
        .when(this.phase === 'success', el => el.child(action('done', 'Done', () => this.finish(), true)))
        .when(this.phase !== 'success', el => el
          .child(action('cancel', 'Cancel', () => this.finish()))
          .when(pasteCallback, el => el.child(action('callback', this.submittingCallback ? 'Connecting…' : 'Connect account', (_event, cx) => this.submitCallback(cx), true)))
          .when(this.phase === 'waiting' && !pasteCallback && Boolean(this.authUrl), el => el.child(action('browser', 'Open browser', (_event, cx) => {
            this.openBrowser(cx);
          }, !pasteCode)))
          .when(pasteCode, el => el.child(action('code', this.sendingCode ? 'Sending…' : 'Submit code', (_event, cx) => this.sendCode(cx), true)))
          .when(!this.busy, el => el.child(action('start', this.phase === 'error' ? 'Try again' : `Continue with ${source.service}`, (_event, cx) => this.start(cx), true)))));
  }
}
