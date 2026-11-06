import { div } from 'gpui-kit';
import { v_flex, h_flex } from 'gpui-base';
import { shared, setShared, props, openOverlay, closeOverlay, exec, appHome, home } from 'herdr';
import { launcherChoices, quotaResetLabel, quotaElapsedPercent } from './model.js';
import { accountLabel, ensureClaudeStatusLine } from './account-login.js';
import { Button } from './components/button.js';
import { Progress } from './components/progress.js';
import { DialogContent, DialogTitle, DialogDescription, DialogFooter } from './components/dialog.js';
import { glyph, AgentIcon } from './components/icon.js';

const usageCacheMs = 5 * 60000;
const usageProvider = agent => !Array.isArray(agent?.run) ? null
  : agent.run.some(arg => !arg.includes('=') && /(?:^|[/\\])codex(?:\.exe)?$/i.test(arg)) ? 'codex'
    // Claude usage comes from the status line Devkits configures: its own accounts and the built-in profile.
    : agent.key === 'claude' || (agent.key?.startsWith('devkits-claude-') && agent.run.some(arg => arg.startsWith('CLAUDE_CONFIG_DIR=')))
      ? 'claude' : null;
const claudeDirectory = agent => agent.run.find(arg => arg.startsWith('CLAUDE_CONFIG_DIR='))?.slice(18) || `${home()}/.claude`;

// The sidebar's usage meters and their details dialog. Mixed into the Devkits view, which provides
// projects and cachedAgents.
export const agentUsage = {
  refreshUsage(cx, force = true, manual = false) {
    const machine = this.projects().find(project => project.active)?.machine || null;
    const hidden = shared('devkits.hidden-launchers') || [];
    const order = shared('devkits.launcher-order') || [];
    const scope = JSON.stringify([machine, hidden, order, shared('devkits.profile-revision') || 0]);
    if (this.usageLoading || (!force && this.usageScope === scope)) return;
    this.usageScope = scope;
    this.usageLoading = true;
    // A manual refresh rediscovers profiles and bypasses the provider cache.
    if (manual) {
      const { [JSON.stringify(machine)]: _, ...rest } = shared('devkits.agent-cache') || {};
      setShared('devkits.agent-cache', rest);
    }
    cx.spawn(async cx => {
      try {
        const agents = await this.cachedAgents(machine);
        this.usageAgents = agents;
        if (this.usageMachine !== machine) this.usage = [];
        this.usageMachine = machine;
        this.usageError = null;
        cx.notify();
        const accounts = launcherChoices(this.usageAgents, order)
          .filter(choice => !hidden.includes(choice.key) && !machine && usageProvider(choice.agent)).map(choice => choice.agent);
        // Cached results survive reloads and restarts so providers are queried at most once per interval.
        const cached = () => shared('devkits.usage-cache') || {};
        const now = Date.now();
        // Set up the status line once per app session; the built-in profile chains any status line it already has.
        this.statusLines ||= new Set();
        for (const account of accounts.filter(account => usageProvider(account) === 'claude' && !this.statusLines.has(account.key))) {
          this.statusLines.add(account.key);
          try { await ensureClaudeStatusLine(claudeDirectory(account), { chain: account.key === 'claude' }); } catch {}
        }
        // Claude usage is a local file, so only provider queries are rate-limited by the cache.
        const stale = accounts.filter(account => manual || usageProvider(account) === 'claude'
          || !(now - (cached()[account.key]?.checkedAt || 0) < usageCacheMs));
        this.usage = accounts.map(account => cached()[account.key]).filter(Boolean);
        if (stale.length) {
          cx.notify();
          const result = await exec('node', [`${appHome()}/mods/devkits/usage-reader.js`,
            JSON.stringify(stale.map(account => ({ ...account, provider: usageProvider(account) })))]);
          if (result.code !== 0) throw new Error('Could not read usage');
          const next = { ...cached() };
          for (const entry of JSON.parse(result.stdout)) {
            const previous = next[entry.key];
            // Keep the last good windows when a later request fails.
            next[entry.key] = entry.error && previous?.windows
              ? { ...previous, error: entry.error, checkedAt: Date.now() } : { ...entry, checkedAt: Date.now() };
          }
          setShared('devkits.usage-cache', next);
          this.usage = accounts.map(account => next[account.key]).filter(Boolean);
        }
      } catch { this.usageError = 'Could not read usage'; }
      finally { this.usageLoading = false; cx.notify(); }
    });
  },

  usageDetails(t) {
    const { account, overlay } = props();
    const close = () => closeOverlay(overlay);
    return DialogContent('usage-details', t).track_focus(this.handle)
      .accessibility_label(`${account.name} usage details`).on_key_down((event, cx) => {
        if (event.key === 'escape') { cx.stop_propagation(); close(); }
      })
      .child(DialogTitle().flex_none().child(account.name))
      .child(DialogDescription(t).flex_none().child(account.supported ? 'Account quota usage' : 'Not supported'))
      .child(v_flex().id('usage-windows').flex_1().min_h(0).overflow_y_scrollbar().gap(16)
        .when(Boolean(account.error), el => el.child(div().text_size(12).text_color(t.muted).child(account.error)))
        .when(account.supported && !account.error && !account.windows?.length, el => el
          .child(div().text_size(12).text_color(t.muted).child('No quota windows available.')))
        .children((account.windows || []).map((window, index) => {
          const elapsed = quotaElapsedPercent(window);
          const duration = window.minutes === null ? 'Unknown duration' : window.minutes % 1440 === 0
            ? `${window.minutes / 1440}d` : window.minutes % 60 === 0 ? `${window.minutes / 60}h` : `${window.minutes}m`;
          return v_flex().flex_none().gap(8)
            .child(h_flex().justify_between().text_size(13)
              .child(`${window.name} · ${duration}`)
              .child(`${Math.round(window.usedPercent)}% used · ${Math.round(100 - window.usedPercent)}% remaining`))
            .child(Progress(`usage-detail-meter-${index}`, window.usedPercent, t, elapsed, window.minutes === 300 ? 5 : window.minutes === 10080 ? 7 : 0)
              .accessibility_label(`${window.name} ${duration} used`))
            .when(elapsed !== null, el => el.child(div().text_size(12).text_color(t.muted)
              .child(`Top: ${Math.round(elapsed)}% of window elapsed · Bottom: quota used`)))
            .child(div().text_size(12).text_color(t.muted)
              .child(quotaResetLabel(window)));
        })))
      .when(Boolean(account.fetchedAt), el => el.child(DialogDescription(t).flex_none()
        .child(`Updated ${new Date(account.fetchedAt).toLocaleString()}`)))
      .child(DialogFooter().flex_none().child(Button('usage-details-done', t).on_click(close).child('Done')));
  },

  accountUsage(t) {
    const space = this.projects().find(s => s.active);
    const choices = launcherChoices(this.usageMachine === (space?.machine || null) ? this.usageAgents || [] : [],
      shared('devkits.launcher-order') || [])
      // The plain terminal launcher is not an agent profile and never has usage.
      .filter(choice => choice.agent && !(shared('devkits.hidden-launchers') || []).includes(choice.key));
    return v_flex().id('account-usage').w_full().flex_none().h_auto().min_h(0)
      .border_t(1).border_color(t.border)
      .child(h_flex().h(32).flex_none().pl(12).items_center()
        .child(div().flex_1().text_size(11).font_medium().text_color(t.muted).child('USAGE'))
        .child(Button('refresh-agent-profiles', t, { variant: 'ghost', size: 'icon' }).h_full().w(32)
          .accessibility_label('Refresh agent profiles').disabled(Boolean(this.usageLoading))
          .on_click((_, cx) => this.refreshUsage(cx, true, true)).child(glyph('refresh-cw')))
        .child(Button('open-token-statistics', t, { variant: 'ghost', size: 'icon' }).h_full().w(32)
          .accessibility_label('Token statistics')
          .on_click(() => openOverlay({ mod: 'devkits', kind: 'dialog', frame: 'none', modal: false, width: 1080, height: 0.85,
            props: { view: 'token-statistics' } })).child(glyph('chart-column')))
        .child(Button('manage-agent-profiles', t, { variant: 'ghost', size: 'icon' }).h_full().w(32)
          .accessibility_label('Manage agent profiles')
          .on_click(() => openOverlay({ mod: 'devkits', kind: 'dialog', frame: 'none', modal: false, width: 680, height: 0.8,
            props: { view: 'manage-launchers', space: space?.id } })).child(glyph('settings'))))
      .child(v_flex().id('account-usage-list').w_full().h_auto().flex_none()
        .children(choices.map(choice => {
            const data = (this.usage || []).find(account => account.key === choice.agent?.key);
            const provider = space?.machine ? null : usageProvider(choice.agent);
            const supported = Boolean(provider);
            const windows = supported ? [300, 10080].flatMap(minutes =>
              data?.windows?.find(window => window.bucket === provider && window.minutes === minutes) || []) : [];
            const status = !supported ? 'Not supported' : data?.error || this.usageError ? 'Unavailable'
              : windows.length ? windows.map(window => `${window.minutes === 300 ? '5h' : 'Week'} ${Math.round(window.usedPercent)}% used · ${quotaResetLabel(window)}`).join(' · ')
                : this.usageLoading ? 'Loading…' : 'No quota';
            const account = { ...data, name: choice.name, supported,
              error: data?.error || (supported ? this.usageError || (this.usageLoading ? 'Reading account usage…' : null) : null) };
            return Button(`usage-${choice.key}`, t, { variant: 'ghost' }).w_full().flex_none().h_auto().px(12).gap(8).items_start().justify_start().py(6)
              .accessibility_label(`${choice.name}: ${status}. Open usage details`)
              .on_click(() => openOverlay({ mod: 'devkits', kind: 'dialog', frame: 'none', modal: false, width: 480, height: 480,
                props: { view: 'usage-details', account } }))
              .child(AgentIcon(choice.agent, t).self_center())
              .child(v_flex().flex_1().min_w(0).gap(3).line_height('12px')
                .child(div().truncate().text_size(12).font_semibold().text_color(t.foreground).child(accountLabel(choice.name)))
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
  },
};
