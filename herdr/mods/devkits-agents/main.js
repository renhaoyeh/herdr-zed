import { View, div } from 'gpui-kit';
import { props, theme, shared, setShared } from 'herdr';
import AccountLogin from './account-login.js';
import { sessionMenu } from './session-menu.js';
import { accountActions } from './account-actions.js';
import { agentProfiles } from './agent-profiles.js';
import { sharedMcpSettings } from './shared-mcp-settings.js';
import { agentSelection } from './components/agent-selection.js';
import { discoverAgents } from './discovery.js';
import { AgentsService } from './service.js';

export default class AgentsMod extends View {
  init(_props, cx) {
    const target = props() || {};
    if (target.view === 'service') { this.service = new AgentsService(); this.service.init(cx); return; }
    if (target.view === 'account-login') { this.login = new AccountLogin(); this.login.init(target, cx); return; }
    if (target.view === 'shared-mcp') { this.initSharedMcp(cx); return; }
    if (target.view === 'rename-account') this.initRenameAccount();
    if (['remove-account', 'rename-account'].includes(target.view)) {
      this.handle = cx.focus_handle();
      if (target.view !== 'rename-account') this.handle.focus();
    } else this.initSessionMenu(cx);
  }
  cachedAgents(machine) { return discoverAgents(machine); }
  // The shell owns native tabs, task routing and focus. Keep the picker alive
  // until the host has prepared the launch successfully.
  startThread(agent, target = props(), options = {}) {
    const { overlay, space, folder, projectName, machine, task } = target;
    setShared('devkits.agents.navigation', [...(shared('devkits.agents.navigation') || []), {
      type: 'start', agent, target: { overlay, space, folder, projectName, machine, task }, options, expiresAt: Date.now() + 10000,
    }]);
  }
  async close() { this.storageClosed = true; await this.login?.close(); }
  render(cx) {
    const t = theme(), view = props()?.view;
    if (view === 'service') { this.service?.poll(cx); return div().size_full(); }
    if (view === 'account-login') return this.login.render();
    if (view === 'shared-mcp') return this.sharedMcpDialog(t);
    if (view === 'rename-account') return this.renameAccountPrompt(t);
    if (view === 'remove-account') return this.removeAccountPrompt(t);
    if (view === 'agent-profile-editor') return this.agentProfileEditor(t);
    if (view === 'launcher') return this.launcher(t);
    this.syncAccountChanges(cx);
    return this.manageLaunchers(t, cx);
  }
}
Object.assign(AgentsMod.prototype, sessionMenu, accountActions, agentProfiles, sharedMcpSettings, agentSelection);
