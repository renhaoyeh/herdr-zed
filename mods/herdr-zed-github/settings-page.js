import { div } from 'gpui-kit';
import { h_flex, v_flex } from 'gpui-base';
import { Button } from './components/button.js';
import { glyph } from './components/icon.js';
import { readGitAccounts, gitBindings, rememberedAuthor, setGitAccount } from './git-auth.js';

// GitHub's page in the Extensions dialog: global, never about one repository. It lists the gh accounts signed in on
// this computer (with the commit author remembered for each and how many repositories use it) and every repository
// bound to an account, which can be unbound here. A repository's account is chosen from its Changes identity row.
const sameAccount = (a, b) => a.host.toLowerCase() === b.host.toLowerCase() && a.login.toLowerCase() === b.login.toLowerCase();
const folderName = folder => folder.replace(/\/+$/, '').split('/').pop() || folder;

export class GitHubSettings {
  init(cx) { this.loadAccounts(cx); }
  close() { this.closed = true; }

  loadAccounts(cx) {
    if (this.loading) return;
    this.loading = true; this.error = null; cx.notify();
    cx.spawn(async cx => {
      try { this.accounts = await readGitAccounts(null); } catch (error) { this.error = error.message; }
      finally { this.loading = false; if (!this.closed) cx.notify(); }
    });
  }

  render(t) {
    const bindings = gitBindings();
    // Accounts bound on this computer but no longer listed by gh still appear, marked as needing sign-in.
    const listed = this.accounts || [];
    const local = bindings.filter(binding => !binding.machine).map(binding => binding.account);
    const accounts = [...listed, ...local.filter(account => !listed.some(item => sameAccount(item, account)))
      .filter((account, index, all) => all.findIndex(item => sameAccount(item, account)) === index)
      .map(account => ({ ...account, available: false }))];
    const card = (id, rows, empty) => v_flex().id(id).flex_none().border(1).border_color(t.border).bg(t.background)
      .children(rows.length ? rows.map((row, index) => index ? row.border_t(1).border_color(t.border) : row)
        : [h_flex().h(40).px(12).items_center().text_size(12).text_color(t.muted).child(empty)]);
    const heading = (title, trailing = null) => h_flex().h(28).px(4).items_center()
      .child(div().flex_1().text_size(11).font_medium().text_color(t.muted).child(title.toUpperCase()))
      .when(Boolean(trailing), el => el.child(trailing));

    const accountRows = accounts.map(account => {
      const author = rememberedAuthor(account, null);
      const uses = bindings.filter(binding => !binding.machine && sameAccount(binding.account, account)).length;
      return h_flex().id(`github-account-${account.host}-${account.login}`).min_h(52).px(12).py(8).gap(12).items_center()
        .child(glyph('github', 16).text_color(t.muted))
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(h_flex().gap(6).items_center()
            .child(div().text_size(13).child(account.login))
            .child(div().text_size(12).text_color(t.muted).child(account.host)))
          .child(div().truncate().text_size(12).text_color(t.muted)
            .child(author ? `Commits as ${author.name} <${author.email}>` : 'No commit author saved yet')))
        .child(div().flex_none().text_size(12).text_color(account.available ? t.muted : t.ansi1)
          .child(account.available ? `${uses} ${uses === 1 ? 'repository' : 'repositories'}` : 'Sign in with gh auth login'));
    });
    const repositoryRows = bindings.map(binding => h_flex().id(`github-repository-${binding.folder}`).min_h(48).px(12).py(6).gap(12).items_center()
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(div().truncate().text_size(13).child(folderName(binding.folder)))
        .child(div().truncate().text_size(12).text_color(t.muted).child(binding.machine ? `${binding.machine}: ${binding.folder}` : binding.folder)))
      .child(div().flex_none().text_size(12).text_color(t.muted).child(`${binding.account.login} · ${binding.account.host}`))
      .child(Button(`github-unbind-${binding.folder}`, t, { variant: 'ghost', size: 'icon-sm' })
        .tooltip('Stop using this account here').accessibility_label(`Stop using ${binding.account.login} in ${folderName(binding.folder)}`)
        .on_click((_event, cx) => { setGitAccount({ machine: binding.machine, folder: binding.folder }, null); cx.notify(); })
        .child(glyph('close', 12))));

    return v_flex().id('github-settings').size_full().min_h(0).px(24).pt(8).pb(24).gap(8).overflow_y_scroll().text_color(t.foreground)
      .child(heading('Accounts on this computer', Button('github-accounts-refresh', t, { variant: 'ghost', size: 'icon-sm' })
        .disabled(Boolean(this.loading)).tooltip(this.error ? 'Retry' : 'Refresh accounts').accessibility_label(this.error ? 'Retry' : 'Refresh accounts')
        .on_click((_event, cx) => this.loadAccounts(cx)).child(glyph('refresh-cw', 12))))
      .child(card('github-accounts', accountRows, this.loading ? 'Loading accounts…' : this.error || 'No accounts. Run gh auth login, then refresh.'))
      .child(div().h(12))
      .child(heading('Repositories using an account'))
      .child(card('github-repositories', repositoryRows, 'None yet. Choose an account for a repository from its identity row in Changes.'))
      .child(div().px(4).pt(4).text_size(12).text_color(t.muted)
        .child('Repositories without an account use this computer\'s Git credentials.'));
  }
}
