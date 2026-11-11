// Shared: edit components/usage.js, then npm run sync:shared.
import { div } from 'gpui-kit';
import { v_flex, h_flex } from 'gpui-base';
import { shared, openOverlay, run, layout } from 'herdr';
import { launcherLabel, quotaResetLabel, quotaElapsedPercent } from './session-model.js';
import { Button } from './button.js';
import { Progress } from './progress.js';
import { glyph, AgentIcon } from './icon.js';
export const usageClientPrefix = 'usage-client:';
const usageServiceMounted = (node = layout()) => Boolean(node && (
  node.content?.mod === 'herdr-zed-agents' && node.content.props?.view === 'service'
  || node.children?.some(child => usageServiceMounted(child))));
export const usageRefreshPrefix = 'usage-refresh:';
export const usageCommand = (prefix, payload) => prefix + encodeURIComponent(JSON.stringify(payload));
export function usageMessage(command, prefix) {
  if (!command.startsWith(prefix)) return null;
  try { return JSON.parse(decodeURIComponent(command.slice(prefix.length))); } catch { return null; }
}
export const openUsageAnalytics = () => openOverlay({ mod: 'herdr-zed-agents', kind: 'dialog', frame: 'none', modal: false, width: 1080, height: 0.85, props: { view: 'token-statistics' } });
export const openUsageDetails = account => openOverlay({ mod: 'herdr-zed-agents', kind: 'dialog', frame: 'none', modal: false, width: 480, height: 480, props: { view: 'usage-details', account } });
// Compact percentages turn the meter's warning colors at the same thresholds.
const percentColor = (percent, t) => percent >= 90 ? t.ansi1 : percent >= 70 ? t.blocked : t.muted;
const shortWindow = window => `${window.minutes === 300 ? '5h' : 'W'} ${Math.round(window.usedPercent)}%`;

export class UsageClient {
  constructor({ context = () => ({ machine: null }), active = () => true } = {}) {
    this.context = context; this.active = active; this.clientId = `usage:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  }
  init(cx) { this.started = true; this.heartbeat(); cx.timer.every(1000, () => this.heartbeat()); cx.timer.every(60000, cx => cx.notify()); }
  heartbeat() {
    if (!this.started || !usageServiceMounted()) return false;
    this.contextSignature = JSON.stringify([Boolean(this.active()), this.context()?.machine || null]);
    run('herdr-zed-agents.' + usageCommand(usageClientPrefix, { id: this.clientId, active: Boolean(this.active()), machine: this.context()?.machine || null }));
    return true;
  }
  sync() { if (this.contextSignature !== JSON.stringify([Boolean(this.active()), this.context()?.machine || null])) this.heartbeat(); }
  close() {
    // Native close commands can outlive their provider; let the five-second lease expire.
    this.started = false;
  }
  refresh() { if (this.heartbeat()) run('herdr-zed-agents.' + usageCommand(usageRefreshPrefix, { id: this.clientId })); }
  snapshot() {
    const machine = this.context()?.machine || null;
    return shared('herdr-zed.usage.snapshot')?.contexts?.[JSON.stringify(machine)] || { machine, choices: [], usage: [], loading: false, error: null };
  }
  // Each shown account's reading, status and display name, shared by the sidebar and status bar presentations.
  // `readable` marks an account whose quota can be read now; only those are shown.
  entries(snapshot = this.snapshot()) {
    return (snapshot.choices || []).map(choice => {
      const data = (snapshot.usage || []).find(account => account.key === choice.agent?.key);
      const provider = choice.provider;
      const supported = Boolean(provider);
      const windows = supported ? [300, 10080].flatMap(minutes =>
        data?.windows?.find(window => window.bucket === provider && window.minutes === minutes) || []) : [];
      const status = windows.map(window => `${window.minutes === 300 ? '5h' : 'Week'} ${Math.round(window.usedPercent)}% used · ${quotaResetLabel(window)}`).join(' · ');
      const account = { ...data, name: choice.name, supported,
        error: data?.error || (supported ? snapshot.error || (snapshot.loading ? 'Reading account usage…' : null) : null) };
      // A Default account is named by its signed-in address, or a muted No account, as in every account list.
      const unnamed = supported && launcherLabel(choice.name) === 'Default account';
      const readable = windows.length > 0 && !data?.error && !snapshot.error;
      return { choice, data, supported, readable, windows, status, account,
        name: unnamed ? data?.email || 'No account' : launcherLabel(choice.name), unknown: unnamed && !data?.email };
    });
  }
  readableEntries(snapshot = this.snapshot()) { return this.entries(snapshot).filter(entry => entry.readable); }

  // One status-bar item per account with readable quota: icon, short name and 5h/W percentages.
  // With none, the item draws nothing and takes no width.
  renderStatus(t, { openMenu = null } = {}) {
    if (this.started) this.sync();
    if (!this.active()) return div().flex_none();
    const entries = this.readableEntries();
    if (!entries.length) return div().flex_none();
    return h_flex().id('status-usage').flex_none().h_full().items_center().gap(2).accessibility_label('Account usage')
      .when(Boolean(openMenu), el => el.on_mouse_down('right', (event, cx) => { cx.stop_propagation(); openMenu(event.position); }))
      .children(entries.map(({ choice, windows, status, account, name, unknown }) =>
        Button(`status-usage-${choice.key}`, t, { variant: 'ghost' }).h_full().px(6).gap(4).text_size(11)
          .accessibility_label(`${choice.name}: ${status}. Open usage details`)
          .on_click(() => openUsageDetails(account))
          .child(AgentIcon(choice.agent, t).size(12))
          .child(div().max_w(96).truncate().text_color(unknown ? t.muted : t.foreground).child(name))
          .children(windows.map(window => div().id(`status-usage-${choice.key}-${window.minutes}`).font_family('Geist Mono')
            .text_color(percentColor(window.usedPercent, t)).child(shortWindow(window))))));
  }

  // The host chooses the presentation: `full` meters with reset times, or one `compact` line of percentages per account.
  // `openMenu(position)` opens the host's right-click menu for this section.
  // With no readable account, one muted line says so and links to the Agents Settings page.
  render(t, { style = 'full', openMenu = null } = {}) {
    if (this.started) this.sync();
    if (!this.active()) return div().h(0).flex_none();
    const snapshot = this.snapshot(), entries = this.readableEntries(snapshot);
    return v_flex().id('account-usage').w_full().flex_none().h_auto().min_h(0)
      .border_t(1).border_color(t.border)
      .when(Boolean(openMenu), el => el.on_mouse_down('right', (event, cx) => { cx.stop_propagation(); openMenu(event.position); }))
      .child(h_flex().h(32).flex_none().pl(12).items_center()
        .child(div().flex_1().text_size(11).font_medium().text_color(t.muted).child('USAGE'))
        .child(Button('refresh-agent-profiles', t, { variant: 'ghost', size: 'icon' }).h_full().w(32)
          .accessibility_label('Refresh agent profiles').disabled(Boolean(snapshot.loading))
          .on_click((_, cx) => this.refresh()).child(glyph('refresh-cw')))
        .child(Button('open-token-statistics', t, { variant: 'ghost', size: 'icon' }).h_full().w(32)
          .accessibility_label('Token statistics')
          .on_click(openUsageAnalytics).child(glyph('chart-column'))))
      .child(v_flex().id('account-usage-list').w_full().h_auto().flex_none()
        .when(!entries.length, el => el.child(h_flex().h(32).px(12).gap(8).items_center().text_size(12)
          .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child('No usage to show'))
          .child(Button('usage-add-account', t, { variant: 'ghost' }).h(24).px(0).text_size(12).text_color(t.accent)
            .accessibility_label('Add an account')
            .on_click(() => run('herdr-zed.settings:agents')).child('Add an account'))))
        .children(entries.map(({ choice, status, account, name, unknown, windows }) => {
            const nameColor = unknown ? t.muted : t.foreground;
            if (style === 'compact') return Button(`usage-${choice.key}`, t, { variant: 'ghost' }).w_full().flex_none().h(28).px(12).gap(8)
              .items_center().justify_start()
              .accessibility_label(`${choice.name}: ${status}. Open usage details`)
              .on_click(() => openUsageDetails(account))
              .child(AgentIcon(choice.agent, t))
              .child(div().id(`usage-name-${choice.key}`).flex_1().min_w(0).truncate().text_size(12).text_color(nameColor).child(name))
              .children(windows.map(window => div().id(`usage-compact-${choice.key}-${window.minutes}`).flex_none()
                .text_size(11).font_family('Geist Mono')
                .text_color(percentColor(window.usedPercent, t)).child(shortWindow(window))));
            return Button(`usage-${choice.key}`, t, { variant: 'ghost' }).w_full().flex_none().h_auto().px(12).gap(8).items_start().justify_start().py(6)
              .accessibility_label(`${choice.name}: ${status}. Open usage details`)
              .on_click(() => openUsageDetails(account))
              .child(AgentIcon(choice.agent, t).self_center())
              .child(v_flex().flex_1().min_w(0).gap(3).line_height('12px')
                .child(div().id(`usage-name-${choice.key}`).truncate().text_size(12).font_semibold().text_color(nameColor).child(name))
                .children(windows.map(window => {
                  const elapsed = quotaElapsedPercent(window);
                  const label = window.minutes === 300 ? '5h' : 'Week';
                  const reset = quotaResetLabel(window);
                  const time = reset === 'Reset time unavailable' ? '—' : reset.startsWith('Reset due')
                    ? 'Reset due' : reset.replace(/^Resets (?:in )?/, '');
                  const displayTime = time.replace(/\b(\d)([dhm])\b/g, '0$1$2');
                  return h_flex().w_full().gap(4).items_center().text_size(10).whitespace_nowrap()
                    .child(div().w(30).flex_none().child(label))
                    .child(Progress(`usage-meter-${choice.key}-${window.minutes}`, window.usedPercent, t, elapsed, window.minutes === 300 ? 5 : 7)
                      .flex_1().w_auto().min_w(0).accessibility_label(`${choice.name} ${label} used${elapsed === null ? '' : `; ${Math.round(elapsed)}% of window elapsed`}`))
                    .child(div().w(24).flex_none().font_family('Geist Mono').text_right().child(`${Math.round(window.usedPercent)}%`))
                    .child(div().id(`usage-reset-${choice.key}-${window.minutes}`).w(54).flex_none().font_family('Geist Mono').text_right()
                      .accessibility_label(reset).child(displayTime));
                })));
          })));
  }
}
