import { View, div } from 'gpui-kit';
import { props, theme, shared, setShared, spaces, run } from 'herdr';
import { newTerminalCommand, surfaceHeightKey } from './components/extension-contract.js';
import AccountLogin from './account-login.js';
import { sessionMenu } from './session-menu.js';
import { accountActions } from './account-actions.js';
import { agentProfiles } from './agent-profiles.js';
import { mcpSetupSettings } from './mcp-setup-settings.js';
import { devkitsSettings } from './devkits-settings.js';
import { eccSettings } from './ecc-settings.js';
import { sharedMcpSettings } from './shared-mcp-settings.js';
import { globalRulesSettings } from './global-rules-settings.js';
import { agentSelection } from './components/agent-selection.js';
import { AgentClient } from './components/agents.js';
import { UsageClient } from './components/usage.js';
import { autoLauncherKey, folderKey } from './components/session-model.js';
import { discoverAgents } from './discovery.js';
import { AgentsService } from './service.js';
import { UsageService } from './usage/service.js';
import { UsageDetails } from './usage/details.js';
import { LAUNCHER_ID } from './launch.js';
import Analytics from './usage/analytics.js';

// One provider mod: the Agents views (picker, settings, accounts) and the Usage views (sidebar, details,
// token statistics). A single `service` view runs both services.
export default class AgentsMod extends View {
  init(_props, cx) {
    const target = props() || {};
    this.viewCx = cx;
    if (target.view === 'service') {
      this.service = new AgentsService(); this.service.init(cx);
      this.usageService = new UsageService(); this.usageService.init(cx);
      return;
    }
    // Usage surfaces mount as native blocks (extension.json); each keeps its own lease with the Usage service.
    if (target.view === 'usage-sidebar') {
      this.usageClient = new UsageClient(); this.usageClient.init(cx);
      // ARCHITECTURE §3.10: report the content height so the shell sizes the sidebar block to it.
      const key = surfaceHeightKey(LAUNCHER_ID, 'usage');
      const report = () => { const px = this.usageClient.contentHeight(); if (shared(key) !== px) setShared(key, px); };
      report(); cx.timer.every(500, report);
      return;
    }
    if (target.view === 'usage-details') { this.details = new UsageDetails(); this.details.init(cx); return; }
    if (target.view === 'token-statistics') { this.analytics = new Analytics(); this.analytics.init(cx); return; }
    if (target.view === 'account-login') { this.login = new AccountLogin(); this.login.init(target, cx); return; }
    if (target.view === 'shared-mcp') { this.initSharedMcp(cx); return; }
    if (target.view === 'launcher') { this.agentClient = new AgentClient(); this.agentClient.init(cx); }
    if (target.view === 'rename-account') this.initRenameAccount(cx);
    if (['remove-account', 'rename-account'].includes(target.view)) {
      this.handle = cx.focus_handle();
      if (target.view !== 'rename-account') this.handle.focus();
    } else this.initSessionMenu(cx);
  }
  cachedAgents(machine) { return discoverAgents(machine); }

  // The picker asks the Agents service to prepare the account and emit the launch request. The shell
  // takes it from there. The picker stays open with the error if preparation fails.
  startThread(agent, target = props() || {}, options = {}) {
    if (!agent) { this.openTerminal(target); return; }
    const { overlay, space, folder, projectName, machine, task } = target;
    this.startError = null;
    this.agentClient.launch(agent, { overlay, space, folder, projectName, machine, ...(task ? { task } : {}) }, options)
      .then(() => this.remember(agent, { space, folder }, options))
      .catch(error => { this.startError = error.message; this.viewCx?.notify(); });
  }
  // A plain terminal needs no account. The shell owns the tab and its shared keys: it opens the same Terminal choice
  // as its native picker and closes the picker overlay carried in the target (ARCHITECTURE §3.1, herdr-zed.new-terminal).
  openTerminal(target) {
    run(`herdr-zed.${newTerminalCommand(target)}`);
  }
  // The launcher remembers the last agent per project; Auto is remembered as its own choice.
  remember(agent, target, options = {}) {
    const project = spaces().find(space => space.id === target.space);
    const key = JSON.stringify([project?.machine || '', folderKey(target.folder) || target.space]);
    const value = options.auto ? autoLauncherKey : agent.key;
    if (!value) return;
    setShared('herdr-zed.last-thread-agent', value);
    setShared('herdr-zed.last-thread-agents', { ...(shared('herdr-zed.last-thread-agents') || {}), [key]: value });
  }
  async close() {
    this.storageClosed = true; this.eccClosed = true; this.capClosed = true;
    // Global Rules saves itself; an edit still waiting for the delay is written before the editor goes.
    this.rulesAuto?.flush().finally(() => this.rulesCustom?.release());
    this.usageClient?.close(); this.agentClient?.close();
    for (const monitor of this.usageService?.monitors.values() || []) monitor.agentClient.close();
    await this.login?.close();
  }
  render(cx) {
    const t = theme(), view = props()?.view;
    if (view === 'service') { this.service?.poll(cx); return div().size_full(); }
    if (view === 'usage-sidebar') return this.usageClient.render(t);
    if (view === 'usage-details') return this.details.render(t);
    if (view === 'token-statistics') return this.analytics.render();
    if (view === 'account-login') return this.login.render();
    if (view === 'shared-mcp') return this.sharedMcpDialog(t);
    if (view === 'rename-account') return this.renameAccountPrompt(t);
    if (view === 'remove-account') return this.removeAccountPrompt(t);
    if (view === 'agent-profile-editor') return this.agentProfileEditor(t);
    if (view === 'profile-defaults') return this.profileDefaults(t);
    if (view === 'launcher') return this.launcher(t);
    this.syncAccountChanges(cx);
    return this.manageLaunchers(t, cx);
  }
}
Object.assign(AgentsMod.prototype, sessionMenu, accountActions, agentProfiles, sharedMcpSettings, devkitsSettings, mcpSetupSettings, eccSettings, globalRulesSettings, agentSelection);
