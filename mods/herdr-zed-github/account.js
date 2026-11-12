import { Input } from './components/input.js';
import { div } from 'gpui-kit';
import { InputState, v_flex, h_flex } from 'gpui-base';
import { props, closeOverlay } from 'herdr';
import { Button } from './components/button.js';
import { glyph } from './components/icon.js';
import { Select, SelectState } from './components/select.js';
import { DialogContent, DialogHeader, DialogDescription } from './components/dialog.js';
import { Autosave } from './components/autosave.js';
import { readGitAuthor, saveGitAuthor } from './git-author.js';
import { gitAccount, setGitAccount, readAccountAuthor, rememberGitAuthor, readGitAccounts } from './git-auth.js';

// The GitHub account of one repository (the git.actions dialog, opened from Changes' identity row). It saves itself
// shortly after the last change (design.md, Saving): the account binding, the remembered author and the repository-local
// commit author, in that order. An empty name or email is never written; closing writes an edit still waiting.
export class GitHubAccount {
  init(cx) {
    this.target = props(); this.project = this.target.context || {};
    this.accountSelect = new SelectState(cx);
    this.name = InputState.new({ placeholder: 'Name' });
    this.email = InputState.new({ placeholder: 'Email' });
    for (const input of [this.name, this.email]) input.on('change', (_event, cx) => cx.notify());
    this.auto = new Autosave({
      snapshot: () => JSON.stringify([this.account, this.name.value(), this.email.value()]),
      valid: () => this.loaded && !this.loading && Boolean(this.name.value().trim() && this.email.value().trim()),
      save: () => this.write(),
    });
    this.auto.attach(cx);
    this.reload(cx);
  }

  // Reads the saved account, the signed-in accounts and the commit author; any unsaved draft is replaced.
  reload(cx) {
    if (!this.project.folder) return;
    this.account = gitAccount(this.project); this.loading = true; this.loaded = false; this.error = null;
    this.loadAccounts(cx);
    cx.spawn(async cx => {
      try {
        const author = await readGitAuthor(this.project.folder, this.project.machine);
        if (this.closed) return;
        this.name.set_value(author.name); this.email.set_value(author.email); this.loaded = true;
        this.auto.reset();
      } catch (error) { this.error = error.message; }
      finally { this.loading = false; if (!this.closed) cx.notify(); }
    });
  }

  loadAccounts(cx) {
    this.accountsLoading = true; this.accountsError = null;
    cx.spawn(async cx => {
      try { this.accounts = await readGitAccounts(this.project.machine); }
      catch (error) { this.accountsError = error.message; }
      finally { this.accountsLoading = false; if (!this.closed) cx.notify(); }
    });
  }

  chooseAccount(key, cx) {
    if (this.loading) return;
    const account = key === 'default' ? null : this.accounts?.[Number(key)];
    if (key !== 'default' && !account?.available) return;
    this.account = account; this.loading = true; this.loaded = false; this.error = null; cx.notify();
    cx.spawn(async cx => {
      let author;
      try { author = account ? await readAccountAuthor(account, this.project.machine)
        : await readGitAuthor(this.project.folder, this.project.machine); }
      catch (error) { this.error = error.message; author = { name: account?.login || '', email: '' }; }
      if (this.closed) return;
      this.name.set_value(author.name); this.email.set_value(author.email);
      this.loading = false; this.loaded = true; cx.notify();
    });
  }

  // The repository is named by its folder, never by its path.
  repositoryName() {
    return this.project.name || String(this.project.folder || '').split(/[\/]/).filter(Boolean).pop() || 'this repository';
  }

  // git errors can name the repository's folder; the page names the repository only, never its path.
  visibleError(message) {
    const folder = this.project.folder;
    if (!message || !folder) return message;
    return [folder, String(folder).replace(/\\/g, '/')].reduce((text, path) => text.split(path).join(this.repositoryName()), String(message));
  }

  close() { this.closed = true; this.name?.release(); this.email?.release(); this.accountSelect?.search?.release(); }

  async write() {
    const author = { name: this.name.value(), email: this.email.value() };
    await saveGitAuthor(this.project.folder, this.project.machine, author);
    if (this.account) rememberGitAuthor(this.account, this.project.machine, author);
    setGitAccount(this.project, this.account);
  }

  // The account choices: Default, each signed-in gh account, and the saved account when gh no longer lists it.
  choices() {
    const choices = [{ key: 'default', label: 'Default', available: true, status: null }, ...(this.accounts || []).map((entry, index) => ({
      key: String(index), label: `${entry.login} (${entry.host})`, available: entry.available, status: entry.available ? null : 'Sign in required' }))];
    if (!this.account) return { choices, selected: 'default' };
    const index = this.accounts?.findIndex(entry => entry.host === this.account.host && entry.login === this.account.login) ?? -1;
    if (index >= 0) return { choices, selected: String(index) };
    choices.push({ key: 'current', label: `${this.account.login} (${this.account.host})`, available: false, status: null });
    return { choices, selected: 'current' };
  }

  render(t) {
    const close = () => { this.auto.flush().finally(() => closeOverlay(this.target.overlay)); };
    const field = (key, label, state) => v_flex().gap(6)
      .child(div().text_size(12).child(label))
      .child(Input.new(state, t).id(`git-author-${key}`).h(32).px(8).text_size(13)
        .bg(t.background).border_b(1).border_color(t.input).text_color(t.foreground)
        .disabled(this.loading || !this.loaded).accessibility_label(label));
    const { choices, selected } = this.choices();
    const description = DialogDescription(t).child('The account this repository uses for Git operations, and the author of future commits. Changes save automatically; an author entered for an account is remembered for it.');
    const refresh = Button('git-accounts-refresh', t, { variant: 'ghost', size: 'icon' }).disabled(this.accountsLoading)
      .accessibility_label(this.accountsError ? 'Retry accounts' : 'Refresh accounts').tooltip(this.accountsError ? 'Retry accounts' : 'Refresh accounts')
      .on_click((_event, cx) => this.loadAccounts(cx)).child(glyph('refresh-cw', 14));
    // shadcn Dialog: header (title with close, description), a body that scrolls, and one status line at the bottom.
    const body = v_flex().id('github-account-body').flex_1().min_h(0).gap(12).overflow_y_scroll()
      .child(div().text_size(12).text_color(t.muted).truncate().child(`Repository: ${this.repositoryName()}`))
      // Controls stay mounted while loading (dimmed, and chooseAccount ignores them), so nothing jumps.
      .child(h_flex().gap(4).items_center()
        .child(div().flex_1().min_w(0).opacity(this.loading ? 0.45 : 1).child(Select('git-account', this.accountSelect, selected,
          choices.map(choice => ({ key: choice.key, label: choice.status ? `${choice.label} · ${choice.status}` : choice.label, color: t.foreground })),
          'GitHub account', (key, cx) => this.chooseAccount(key, cx), t, { fullWidth: true })))
        .child(refresh))
      .child(field('name', 'Name', this.name)).child(field('email', 'Email', this.email));
    const error = this.error || this.auto.error || this.accountsError;
    const incomplete = this.loaded && !this.loading && !(this.name.value().trim() && this.email.value().trim());
    const status = error ? this.visibleError(error) : this.loading ? 'Loading commit author…' : this.accountsLoading ? 'Loading accounts…'
      : incomplete ? 'Name and email are required' : this.auto.status();
    const footer = h_flex().flex_none().h(20).items_center()
      .child(div().id('github-account-status').flex_1().min_w(0).truncate().text_size(12).text_color(error || incomplete ? t.ansi1 : t.muted)
        .when(Boolean(error), el => el.tooltip(this.visibleError(error))).child(status));
    return DialogContent('github-account', t).min_h(0).on_key_down((event, cx) => {
      if (event.key === 'escape') { cx.stop_propagation(); close(); }
    }).child(v_flex().id('github-account-header').flex_none().gap(6)
        .child(DialogHeader(t, 'GitHub account', { id: 'github-account-close', label: 'Close GitHub account', onClose: () => close() }))
        .child(description))
      .child(body).child(footer);
  }
}
