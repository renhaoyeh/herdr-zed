import { View, div } from 'gpui-kit';
import { props, theme, shared, setShared, spaces, run } from 'herdr';
import { newTerminalCommand } from './components/extension-contract.js';
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
import Analytics from './usage/analytics.js';

// The status reading's emptiness, read by the shell (ARCHITECTURE §3.8): extension id `agents`, surface `usage-status`.
const USAGE_STATUS_EMPTY = 'herdr-zed.surface-empty.agents.usage-status';

// One provider mod: the Agents views (picker, settings, accounts) and the Usage views (sidebar, details,
// token statistics). A single `service` view runs both services.
export default class AgentsMod extends View {
  init(_props, cx) {
    const target = props() || {};
    this.viewCx = cx;
    if (target.view === 'service') {
      this.service = new AgentsService(); this.service.init(cx);
      this.usageService = new UsageService(); this.usageService.init(cx);
      // Hidden surfaces lose their view/timers. Keep the status subscription and emptiness reporter in the
      // always-mounted service so an empty reading can discover data and become visible again.
      this.usageClient = new UsageClient(); this.usageClient.init(cx);
      this.reportStatusEmpty(cx);
      return;
    }
    // Usage surfaces mount as native blocks (extension.json); each keeps its own lease with the Usage service.
    if (['usage-sidebar', 'usage-status'].includes(target.view)) {
      this.usageClient = new UsageClient(); this.usageClient.init(cx);
      return;
    }
    if (target.view === 'usage-details') { this.details = new UsageDetails(); this.details.init(cx); return; }
    if (target.view === 'token-statistics') { this.analytics = new Analytics(); this.analytics.init(cx); return; }
    if (target.view === 'account-login') { this.login = new AccountLogin(); this.login.init(target, cx); return; }
    if (target.view === 'shared-mcp') { this.initSharedMcp(cx); return; }
    if (target.view === 'launcher') { this.agentClient = new AgentClient(); this.agentClient.init(cx); }
    if (target.view === 'rename-account') this.initRenameAccount();
    if (['remove-account', 'rename-account'].includes(target.view)) {
      this.handle = cx.focus_handle();
      if (target.view !== 'rename-account') this.handle.focus();
    } else this.initSessionMenu(cx);
  }
  cachedAgents(machine) { return discoverAgents(machine); }

  // The shell hides the status reading while it has nothing to show (ARCHITECTURE §3.8). Checked from a timer, never from
  // render, and written only when the value changes.
  reportStatusEmpty(cx) {
    const report = () => {
      const empty = !this.usageClient.active() || !this.usageClient.readableEntries().length;
      if (empty === this.statusEmpty) return;
      this.statusEmpty = empty;
      setShared(USAGE_STATUS_EMPTY, empty);
    };
    report();
    cx.timer.every(1000, report);
  }

  // The picker asks the Agents service to prepare the account and emit the launch request. The shell
  // takes it from there. The picker stays open with the error if preparation fails.
  startThread(agent, target = props() || {}, options = {}) {
    if (!agent) { this.openTerminal(target); return; }
    const { overlay, space, folder, projectName, machine } = target;
    this.startError = null;
    this.agentClient.launch(agent, { overlay, space, folder, projectName, machine }, options)
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
    this.storageClosed = true; this.eccClosed = true; this.capClosed = true; this.rulesCustom?.release(); this.rulesPreview?.release();
    this.usageClient?.close(); this.agentClient?.close();
    for (const monitor of this.usageService?.monitors.values() || []) monitor.agentClient.close();
    await this.login?.close();
  }
  render(cx) {
    const t = theme(), view = props()?.view;
    if (view === 'service') { this.service?.poll(cx); return div().size_full(); }
    if (view === 'usage-sidebar') return this.usageClient.render(t);
    if (view === 'usage-status') return this.usageClient.renderStatus(t);
    if (view === 'usage-details') return this.details.render(t);
    if (view === 'token-statistics') return this.analytics.render();
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
Object.assign(AgentsMod.prototype, sessionMenu, accountActions, agentProfiles, sharedMcpSettings, devkitsSettings, mcpSetupSettings, eccSettings, globalRulesSettings, agentSelection);
