// Shared: edit mods/devkits/components/usage.js, then npm run sync:shared.
import { div } from 'gpui-kit';
import { v_flex, h_flex } from 'gpui-base';
import { shared, openOverlay, run, layout } from 'herdr';
import { launcherLabel, quotaResetLabel, quotaElapsedPercent } from './session-model.js';
import { Button } from './button.js';
import { Progress } from './progress.js';
import { glyph, AgentIcon } from './icon.js';
export const usageClientPrefix = 'usage-client:';
const usageServiceMounted = (node = layout()) => Boolean(node && (
  node.content?.mod === 'devkits-usage' && node.content.props?.view === 'service'
  || node.children?.some(child => usageServiceMounted(child))));
export const usageRefreshPrefix = 'usage-refresh:';
export const usageCommand = (prefix, payload) => prefix + encodeURIComponent(JSON.stringify(payload));
export function usageMessage(command, prefix) {
  if (!command.startsWith(prefix)) return null;
  try { return JSON.parse(decodeURIComponent(command.slice(prefix.length))); } catch { return null; }
}
export const openUsageAnalytics = () => openOverlay({ mod: 'devkits-usage', kind: 'dialog', frame: 'none', modal: false, width: 1080, height: 0.85, props: { view: 'token-statistics' } });
export const openUsageDetails = account => openOverlay({ mod: 'devkits-usage', kind: 'dialog', frame: 'none', modal: false, width: 480, height: 480, props: { view: 'usage-details', account } });
export class UsageClient {
  constructor({ context = () => ({ machine: null }), active = () => true } = {}) {
    this.context = context; this.active = active; this.clientId = `usage:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  }
  init(cx) { this.started = true; this.heartbeat(); cx.timer.every(1000, () => this.heartbeat()); cx.timer.every(60000, cx => cx.notify()); }
  heartbeat() {
    if (!this.started || !usageServiceMounted()) return false;
    this.contextSignature = JSON.stringify([Boolean(this.active()), this.context()?.machine || null]);
    run('devkits-usage.' + usageCommand(usageClientPrefix, { id: this.clientId, active: Boolean(this.active()), machine: this.context()?.machine || null }));
    return true;
  }
  sync() { if (this.contextSignature !== JSON.stringify([Boolean(this.active()), this.context()?.machine || null])) this.heartbeat(); }
  close() {
    // Native close commands can outlive their provider; let the five-second lease expire.
    this.started = false;
  }
  refresh() { if (this.heartbeat()) run('devkits-usage.' + usageCommand(usageRefreshPrefix, { id: this.clientId })); }
  snapshot() {
    const machine = this.context()?.machine || null;
    return shared('devkits.usage.snapshot')?.contexts?.[JSON.stringify(machine)] || { machine, choices: [], usage: [], loading: false, error: null };
  }
  render(t) {
    if (this.started) this.sync();
    if (!this.active()) return div().h(0).flex_none();
    const snapshot = this.snapshot(), choices = snapshot.choices || [];
    return v_flex().id('account-usage').w_full().flex_none().h_auto().min_h(0)
      .border_t(1).border_color(t.border)
      .child(h_flex().h(32).flex_none().pl(12).items_center()
        .child(div().flex_1().text_size(11).font_medium().text_color(t.muted).child('USAGE'))
        .child(Button('refresh-agent-profiles', t, { variant: 'ghost', size: 'icon' }).h_full().w(32)
          .accessibility_label('Refresh agent profiles').disabled(Boolean(snapshot.loading))
          .on_click((_, cx) => this.refresh()).child(glyph('refresh-cw')))
        .child(Button('open-token-statistics', t, { variant: 'ghost', size: 'icon' }).h_full().w(32)
          .accessibility_label('Token statistics')
          .on_click(openUsageAnalytics).child(glyph('chart-column'))))
      .child(v_flex().id('account-usage-list').w_full().h_auto().flex_none()
        .children(choices.map(choice => {
            const data = (snapshot.usage || []).find(account => account.key === choice.agent?.key);
            const provider = choice.provider;
            const supported = Boolean(provider);
            const windows = supported ? [300, 10080].flatMap(minutes =>
              data?.windows?.find(window => window.bucket === provider && window.minutes === minutes) || []) : [];
            const status = !supported ? 'Not supported' : data?.error || snapshot.error ? 'Unavailable'
              : windows.length ? windows.map(window => `${window.minutes === 300 ? '5h' : 'Week'} ${Math.round(window.usedPercent)}% used · ${quotaResetLabel(window)}`).join(' · ')
                : snapshot.loading ? 'Loading…' : 'No quota';
            const account = { ...data, name: choice.name, supported,
              error: data?.error || (supported ? snapshot.error || (snapshot.loading ? 'Reading account usage…' : null) : null) };
            return Button(`usage-${choice.key}`, t, { variant: 'ghost' }).w_full().flex_none().h_auto().px(12).gap(8).items_start().justify_start().py(6)
              .accessibility_label(`${choice.name}: ${status}. Open usage details`)
              .on_click(() => openUsageDetails(account))
              .child(AgentIcon(choice.agent, t).self_center())
              .child(v_flex().flex_1().min_w(0).gap(3).line_height('12px')
                // A Default account is named by its signed-in address, or a muted No account, as in every account list.
                .child(div().id(`usage-name-${choice.key}`).truncate().text_size(12).font_semibold()
                  .text_color(supported && launcherLabel(choice.name) === 'Default account' && !data?.email ? t.muted : t.foreground)
                  .child(supported && launcherLabel(choice.name) === 'Default account' ? data?.email || 'No account' : launcherLabel(choice.name)))
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
                }))
                .when(!windows.length, el => el
                  .child(div().text_size(10).child(status))
                  .child(Progress(`usage-meter-${choice.key}`, null, t).accessibility_label(`${choice.name}: ${status}`))));
          })));
  }
}
