import { Input } from './components/input.js';
import { div } from 'gpui-kit';
import { InputState, v_flex } from 'gpui-base';
import { props, closeOverlay } from 'herdr';
import { Button } from './components/button.js';
import { Select, SelectState } from './components/select.js';
import { DialogContent, DialogTitle, DialogDescription, DialogFooter } from './components/dialog.js';
import { readGitAuthor, saveGitAuthor } from './git-author.js';
import { gitAccount, setGitAccount, readAccountAuthor, rememberGitAuthor, readGitAccounts } from './git-auth.js';

// The GitHub account of one repository. Save writes the account binding, the remembered author and the
// repository-local commit author, in that order; Cancel discards the draft.
// Standalone (the git.actions popup) it is a dialog that closes on Save and Cancel. Embedded in the shell's
// Settings it is the page body: the shell owns the frame and closing, and Cancel only discards the draft.
export class GitHubAccount {
  init(cx) {
    this.target = props(); this.project = this.target.context || {}; this.embedded = Boolean(this.target.embedded);
    this.accountSelect = new SelectState(cx);
    this.name = InputState.new({ placeholder: 'Name' });
    this.email = InputState.new({ placeholder: 'Email' });
    for (const input of [this.name, this.email]) input.on('change', (_event, cx) => cx.notify());
    this.reload(cx);
  }

  // Reads the saved account, the signed-in accounts and the commit author; any unsaved draft is replaced.
  reload(cx) {
    this.account = gitAccount(this.project); this.loading = true; this.loaded = false; this.error = null;
    this.loadAccounts(cx);
    cx.spawn(async cx => {
      try {
        const author = await readGitAuthor(this.project.folder, this.project.machine);
        if (this.closed) return;
        this.name.set_value(author.name); this.email.set_value(author.email); this.loaded = true;
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
    if (this.loading || this.saving) return;
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

  close() { this.closed = true; this.name?.release(); this.email?.release(); this.accountSelect?.search?.release(); }

  save(cx) {
    if (!this.loaded || this.saving || !this.name.value().trim() || !this.email.value().trim()) return;
    const author = { name: this.name.value(), email: this.email.value() };
    this.saving = true; this.error = null; cx.notify();
    cx.spawn(async cx => {
      try {
        await saveGitAuthor(this.project.folder, this.project.machine, author);
        if (this.account) rememberGitAuthor(this.account, this.project.machine, author);
        setGitAccount(this.project, this.account);
        if (!this.closed && !this.embedded) closeOverlay(this.target.overlay);
      } catch (error) { this.error = error.message; }
      finally { this.saving = false; if (!this.closed) cx.notify(); }
    });
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
    const embedded = this.embedded;
    const cancel = cx => {
      if (this.saving) return;
      if (embedded) this.reload(cx); else closeOverlay(this.target.overlay);
    };
    const field = (key, label, state) => v_flex().gap(6)
      .child(div().text_size(12).child(label))
      .child(Input.new(state, t).id(`git-author-${key}`).h(32).px(8).text_size(13)
        .bg(t.background).border_b(1).border_color(t.input).text_color(t.foreground)
        .disabled(this.loading || this.saving || !this.loaded).accessibility_label(label));
    const { choices, selected } = this.choices();
    const accountList = () => v_flex().id('git-account-list').gap(4)
      .children(choices.map(choice => Button(`git-account-${choice.key}`, t, { variant: 'ghost' }).w_full().h(36).px(10).justify_start()
        .bg(choice.key === selected ? t.selected : t.popover).text_color(t.foreground)
        .disabled(this.loading || this.saving || !(choice.key === 'default' || choice.available))
        .accessibility_label(`${choice.label}${choice.status ? `, ${choice.status}` : ''}${choice.key === selected ? ', selected' : ''}`)
        .on_click((_event, cx) => this.chooseAccount(choice.key, cx))
        .child(div().min_w(0).truncate().child(choice.label))
        .when(Boolean(choice.status), el => el.child(div().flex_none().text_size(11).text_color(t.muted).child(choice.status)))));
    const body = v_flex().gap(12)
      .when(!embedded && !this.loading && !this.saving, el => el.child(Select('git-account', this.accountSelect, selected,
        choices.map(choice => ({ key: choice.key, label: choice.status ? `${choice.label} · ${choice.status}` : choice.label, color: t.foreground })),
        'GitHub account', (key, cx) => this.chooseAccount(key, cx), t, { fullWidth: true })))
      .when(embedded && !this.loading && !this.saving, el => el.child(accountList()))
      .when(this.accountsLoading, el => el.child(div().text_size(12).text_color(t.muted).child('Loading accounts…')))
      .when(Boolean(this.accountsError), el => el.child(div().text_size(12).text_color(t.ansi1).child(this.accountsError)))
      .child(Button('git-accounts-refresh', t, { variant: 'secondary' }).disabled(this.accountsLoading || this.saving)
        .on_click((_event, cx) => this.loadAccounts(cx)).child(this.accountsError ? 'Retry accounts' : 'Refresh accounts'))
      .child(DialogDescription(t).child(this.account
        ? `Use ${this.account.login} (${this.account.host}) for Git operations and future commits. If GitHub does not provide a public email, enter it once; this author will be remembered for the account.`
        : 'Set the name and email for future commits in this repository. Existing commits stay unchanged.'))
      .child(div().text_size(11).text_color(t.muted).child(this.project.folder))
      .child(field('name', 'Name', this.name)).child(field('email', 'Email', this.email))
      .when(this.loading, el => el.child(div().text_size(12).text_color(t.muted).child('Loading commit author…')))
      .when(Boolean(this.error), el => el.child(div().text_size(12).text_color(t.ansi1).child(this.error)))
      .child(DialogFooter()
        .child(Button('git-author-cancel', t, { variant: 'secondary' }).disabled(Boolean(this.saving)).on_click((_event, cx) => cancel(cx)).child('Cancel'))
        .child(Button('git-author-save', t).disabled(!this.loaded || this.saving || !this.name.value().trim() || !this.email.value().trim())
          .on_click((_event, cx) => this.save(cx)).child(this.saving ? 'Saving…' : 'Save')));
    const title = DialogTitle().child(embedded ? 'GitHub' : 'GitHub account');
    if (embedded) return v_flex().id('github-account').size_full().min_h(0).gap(12).text_color(t.foreground).overflow_y_scroll()
      .child(title).child(body);
    return DialogContent('github-account', t).gap(12).on_key_down((event, cx) => {
      if (event.key === 'escape') { cx.stop_propagation(); cancel(cx); }
    }).child(title).child(body);
  }
}
