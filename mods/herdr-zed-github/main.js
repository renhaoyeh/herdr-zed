import { View, div } from 'gpui-kit';
import { theme, props } from 'herdr';
import { GitHubAccount } from './account.js';
import { GitHubSettings } from './settings-page.js';
import { publishGitCredentials } from './git-auth.js';

// The service mounts while the extension is enabled, so the Git binding exists before any dialog opens.
// Disabling clears the binding in the shell (ARCHITECTURE §3.5).
// `account` is the git.actions popup for one repository; `settings` is the global page in the Extensions dialog.
export default class GitHubExtension extends View {
  init(_props, cx) {
    const view = props()?.view;
    if (view === 'service') { publishGitCredentials(); return; }
    if (view === 'account') { this.account = new GitHubAccount(); this.account.init(cx); }
    if (view === 'settings') { this.settings = new GitHubSettings(); this.settings.init(cx); }
  }

  close() { this.account?.close(); this.settings?.close(); }

  render() {
    const view = props()?.view;
    if (view === 'account') return this.account.render(theme());
    if (view === 'settings') return this.settings.render(theme());
    return div();
  }
}
