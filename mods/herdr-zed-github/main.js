import { View, div } from 'gpui-kit';
import { theme, props } from 'herdr';
import { GitHubAccount } from './account.js';
import { publishGitCredentials } from './git-auth.js';

// The service mounts while the extension is enabled, so the Git binding exists before any dialog opens.
// Disabling clears the binding in the shell (ARCHITECTURE §3.5).
export default class GitHubExtension extends View {
  init(_props, cx) {
    const view = props()?.view;
    if (view === 'service') { publishGitCredentials(); return; }
    if (view === 'account') { this.account = new GitHubAccount(); this.account.init(cx); }
  }

  close() { this.account?.close(); }

  render() {
    const view = props()?.view;
    if (view === 'account') return this.account.render(theme());
    return div();
  }
}
