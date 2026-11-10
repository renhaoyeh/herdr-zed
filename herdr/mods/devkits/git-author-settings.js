import { div } from 'gpui-kit';
import { Input, InputState, v_flex } from 'gpui-base';
import { props, openOverlay, closeOverlay } from 'herdr';
import { Button } from './components/button.js';
import { Select, SelectState } from './components/select.js';
import { DialogContent, DialogTitle, DialogDescription, DialogFooter } from './components/dialog.js';
import { readGitAuthor, saveGitAuthor } from './git-author.js';
import { gitAccount, setGitAccount, readAccountAuthor, rememberGitAuthor, readGitAccounts } from './git-auth.js';

export const openGitAuthor = (project, account, accountPicker = false) => openOverlay({ mod: 'devkits', kind: 'dialog', frame: 'none',
  modal: true, width: 480, height: 600, props: { view: 'git-author-settings', folder: project.folder, machine: project.machine, account, accountPicker } });

export class GitAuthorSettings {
  init(cx) {
    this.target = props(); this.loading = true;
    this.account = this.target.account || gitAccount(this.target);
    if (this.target.accountPicker) { this.accountSelect = new SelectState(cx); this.loadAccounts(cx); }
    this.name = InputState.new({ placeholder: 'Name' });
    this.email = InputState.new({ placeholder: 'Email' });
    for (const input of [this.name, this.email]) input.on('change', (_event, cx) => cx.notify());
    cx.spawn(async cx => {
      try {
        let author;
        if (this.target.account) {
          try { author = await readAccountAuthor(this.account, this.target.machine); }
          catch (error) { this.error = error.message; author = { name: this.account.login, email: '' }; }
        } else author = await readGitAuthor(this.target.folder, this.target.machine);
        if (this.closed) return;
        this.name.set_value(author.name); this.email.set_value(author.email); this.loaded = true;
      } catch (error) { this.error = error.message; }
      finally { this.loading = false; if (!this.closed) cx.notify(); }
    });
  }

  loadAccounts(cx) {
    this.accountsLoading = true; this.accountsError = null;
    cx.spawn(async cx => {
      try { this.accounts = await readGitAccounts(this.target.machine); }
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
      try { author = account ? await readAccountAuthor(account, this.target.machine)
        : await readGitAuthor(this.target.folder, this.target.machine); }
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
        await saveGitAuthor(this.target.folder, this.target.machine, author);
        if (this.account) rememberGitAuthor(this.account, this.target.machine, author);
        if (this.target.account || this.target.accountPicker) setGitAccount(this.target, this.account);
        if (!this.closed) closeOverlay(this.target.overlay);
      } catch (error) { this.error = error.message; }
      finally { this.saving = false; if (!this.closed) cx.notify(); }
    });
  }

  render(t) {
    const cancel = () => { if (!this.saving) closeOverlay(this.target.overlay); };
    const field = (key, label, state) => v_flex().gap(6)
      .child(div().text_size(12).child(label))
      .child(Input.new(state).id(`git-author-${key}`).h(32).px(8).text_size(13)
        .bg(t.background).border_b(1).border_color(t.input).text_color(t.foreground)
        .disabled(this.loading || this.saving || !this.loaded).accessibility_label(label));
    return DialogContent('git-author-settings', t).gap(12).on_key_down((event, cx) => {
      if (event.key === 'escape') { cx.stop_propagation(); cancel(); }
    })
      .child(DialogTitle().child(this.target.accountPicker ? 'GitHub account' : 'Commit author'))
      .when(Boolean(this.target.accountPicker), el => {
        const options = [{ key: 'default', label: 'Default', color: t.foreground },
          ...(this.accounts || []).map((entry, index) => ({ key: String(index),
            label: `${entry.login} (${entry.host})${entry.available ? '' : ' · Sign in required'}`, color: t.foreground }))];
        let selected = this.account ? this.accounts?.findIndex(entry => entry.host === this.account.host && entry.login === this.account.login) : 'default';
        if (this.account && (selected == null || selected < 0)) {
          selected = 'current'; options.push({ key: selected, label: `${this.account.login} (${this.account.host})`, color: t.foreground });
        }
        return el.when(!this.loading && !this.saving, el => el.child(Select('git-account', this.accountSelect, String(selected), options,
          'GitHub account', (key, cx) => this.chooseAccount(key, cx), t, { fullWidth: true })))
          .when(this.accountsLoading, el => el.child(div().text_size(12).text_color(t.muted).child('Loading accounts…')))
          .when(Boolean(this.accountsError), el => el.child(div().text_size(12).text_color(t.ansi1).child(this.accountsError)))
          .child(Button('git-accounts-refresh', t, { variant: 'secondary' }).disabled(this.accountsLoading || this.saving)
            .on_click((_event, cx) => this.loadAccounts(cx)).child(this.accountsError ? 'Retry accounts' : 'Refresh accounts'));
      })
      .child(DialogDescription(t).child(this.account
        ? `Use ${this.account.login} (${this.account.host}) for Git operations and future commits. If GitHub does not provide a public email, enter it once; this author will be remembered for the account.`
        : 'Set the name and email for future commits in this repository. Existing commits stay unchanged.'))
      .child(div().text_size(11).text_color(t.muted).child(this.target.folder))
      .child(field('name', 'Name', this.name)).child(field('email', 'Email', this.email))
      .when(this.loading, el => el.child(div().text_size(12).text_color(t.muted).child('Loading commit author…')))
      .when(Boolean(this.error), el => el.child(div().text_size(12).text_color(t.ansi1).child(this.error)))
      .child(DialogFooter()
        .child(Button('git-author-cancel', t, { variant: 'secondary' }).disabled(Boolean(this.saving)).on_click(cancel).child('Cancel'))
        .child(Button('git-author-save', t).disabled(!this.loaded || this.saving || !this.name.value().trim() || !this.email.value().trim())
          .on_click((_event, cx) => this.save(cx)).child(this.saving ? 'Saving…' : 'Save')));
  }
}
