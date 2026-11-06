import { div } from 'gpui-kit';
import { h_flex, v_flex } from 'gpui-base';
import { exec, appHome, knownAgents, closeOverlay, props, theme } from 'herdr';
import { summarize } from './analytics-model.js';
import { Button } from './components/button.js';
import { DialogContent, DialogTitle, DialogDescription, DialogFooter } from './components/dialog.js';

const number = value => String(Math.round(value || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const short = value => value >= 1e9 ? `${(value / 1e9).toFixed(1)}B` : value >= 1e6 ? `${(value / 1e6).toFixed(1)}M` : value >= 1000 ? `${(value / 1000).toFixed(1)}K` : number(value);

export default class Analytics {
  init(cx) {
    this.days = 30; this.tab = 'model'; this.page = 0; this.filters = {}; this.handle = cx.focus_handle(); this.handle.focus();
    this.refresh(cx);
    cx.timer.every(60000, cx => this.refresh(cx));
  }

  refresh(cx) {
    if (this.loading) return;
    this.loading = true;
    cx.spawn(async cx => {
      try {
        const accounts = (await knownAgents()).flatMap(agent => {
          const provider = agent.run?.some(arg => /(?:^|[/\\])codex(?:\.exe)?$/i.test(arg)) ? 'codex'
            : agent.key === 'claude' || agent.run?.some(arg => arg.startsWith('CLAUDE_CONFIG_DIR=')) ? 'claude' : null;
          return provider ? [{ ...agent, provider }] : [];
        });
        const result = await exec('node', [`${appHome()}/mods/devkits/analytics-reader.js`, appHome(), JSON.stringify(accounts)]);
        if (result.code !== 0) throw new Error('Could not read local token statistics.');
        this.data = JSON.parse(result.stdout); this.error = null;
      } catch (error) { this.error = error.message; }
      finally { this.loading = false; cx.notify(); }
    });
  }

  render() {
    const t = theme(), close = () => closeOverlay(props().overlay);
    const stats = summarize(this.data?.events || [], this.days, new Date(), this.filters);
    const rows = stats[this.tab], pages = Math.max(1, Math.ceil(rows.length / 15));
    this.page = Math.min(this.page, pages - 1);
    const max = Math.max(1, ...stats.daily.map(row => row.total));
    const label = row => this.tab === 'session'
      ? `${row.project.split(/[/\\]/).pop()} · ${new Date(row.timestamp).toLocaleString()} · ${row.label.slice(-8)}` : row.label;
    return DialogContent('token-statistics', t).gap(12).track_focus(this.handle).accessibility_label('Token statistics')
      .on_key_down((event, cx) => { if (event.key === 'escape') { cx.stop_propagation(); close(); } })
      .child(h_flex().flex_none().items_center().gap(12)
        .child(DialogTitle().flex_1().child('Token statistics'))
        .children([[1, 'Today'], [7, '7 days'], [30, '30 days'], [0, 'All time']].map(([days, text]) =>
          Button(`analytics-range-${days}`, t, { variant: this.days === days ? 'default' : 'ghost' }).child(text)
            .on_click((_event, cx) => { this.days = days; this.page = 0; cx.notify(); }))))
      .child(DialogDescription(t).flex_none().child('Local Codex and Claude history · Input excludes cache reads · Reasoning is included in output'))
      .child(v_flex().flex_1().min_h(0).overflow_y_scroll().gap(16)
        .when(Boolean(this.error), el => el.child(DialogDescription(t).child(this.error)))
        .when(!this.data, el => el.child(DialogDescription(t).child(this.loading ? 'Reading local history…' : 'No statistics available.')))
        .when(Boolean(Object.keys(this.filters).length), el => el.child(h_flex().gap(12).items_center()
          .child(DialogDescription(t).flex_1().child(Object.entries(this.filters).map(([key, value]) => `${key}: ${value}`).join(' · ')))
          .child(Button('analytics-clear', t, { variant: 'outline' }).child('Clear filters').on_click((_e, cx) => { this.filters = {}; this.page = 0; cx.notify(); }))))
        .child(h_flex().flex_none().gap(16).children([
          ['Total tokens', stats.totals.total], ['Input', stats.totals.input], ['Output', stats.totals.output],
          ['Cache read', stats.totals.cacheRead], ['Cache write', stats.totals.cacheWrite], ['Sessions', stats.sessions],
        ].map(([title, value]) => v_flex().flex_1().min_w(0).gap(4)
          .child(div().text_size(11).text_color(t.muted).child(title))
          .child(div().text_size(20).font_medium().child(short(value))).accessibility_label(`${title}: ${number(value)}`))))
        .child(v_flex().flex_none().gap(8)
          .child(div().text_size(11).text_color(t.muted).child('DAILY TOKENS'))
          .child(h_flex().h(100).flex_none().items_end().gap(2).children(stats.daily.map(row => div().flex_1().min_w(0)
            .h(Math.max(1, row.total / max * 100)).bg(row.total ? t.solid : t.border)
            .accessibility_label(`${row.label}: ${number(row.total)} tokens`)
            .on_click((_event, cx) => { if (row.total) { this.filters = { ...this.filters, day: row.label }; this.page = 0; cx.notify(); } }))))
          .child(h_flex().justify_between().text_size(11).text_color(t.muted)
            .child(stats.daily[0]?.label || '').child(stats.daily.at(-1)?.label || '')))
        .child(h_flex().flex_none().gap(4).children([['model', 'Models'], ['project', 'Projects'], ['account', 'Accounts'], ['session', 'Sessions']]
          .map(([key, title]) => Button(`analytics-tab-${key}`, t, { variant: this.tab === key ? 'default' : 'ghost' }).child(title)
            .on_click((_event, cx) => { this.tab = key; this.page = 0; cx.notify(); }))))
        .child(h_flex().flex_none().gap(8).text_size(11).text_color(t.muted)
          .child(div().flex_1().child(this.tab === 'session' ? 'SESSION · PROJECT / LAST ACTIVITY' : 'NAME · CLICK TO FILTER'))
          .children(['INPUT', 'OUTPUT', 'CACHE READ', 'CACHE WRITE', 'TOTAL'].map(text => div().w(92).text_right().child(text))))
        .child(v_flex().flex_none().children(rows.slice(this.page * 15, this.page * 15 + 15).map((row, index) =>
          h_flex().id(`analytics-row-${index}`).flex_none().h(36).gap(8).items_center().border_b(1).border_color(t.border).text_size(12)
            .when(this.tab !== 'session', el => el.cursor_pointer().hover(el => el.bg(t.hover))
              .on_click((_event, cx) => { this.filters = { ...this.filters, [this.tab]: row.label }; this.page = 0; cx.notify(); }))
            .child(div().flex_1().min_w(0).truncate().accessibility_label(label(row)).child(label(row)))
            .children(['input', 'output', 'cacheRead', 'cacheWrite', 'total'].map(key => div().w(92).flex_none().text_right()
              .accessibility_label(`${key}: ${number(row[key])} tokens`).child(short(row[key])))))))
        .when(!rows.length && Boolean(this.data), el => el.child(DialogDescription(t).child('No recorded usage in this range.')))
        .when(pages > 1, el => el.child(h_flex().flex_none().justify_end().items_center().gap(12)
          .child(Button('analytics-prev', t, { variant: 'ghost' }).disabled(!this.page).child('Previous').on_click((_e, cx) => { this.page--; cx.notify(); }))
          .child(div().text_size(12).child(`${this.page + 1} / ${pages}`))
          .child(Button('analytics-next', t, { variant: 'ghost' }).disabled(this.page + 1 >= pages).child('Next').on_click((_e, cx) => { this.page++; cx.notify(); }))))
        .children((this.data?.errors || []).map(error => DialogDescription(t).child(error))))
      .child(DialogFooter().flex_none().items_center()
        .child(DialogDescription(t).flex_1().child(this.data ? `${this.data.fileCount} history files · Updated ${new Date(this.data.updatedAt).toLocaleTimeString()}${this.loading ? ' · Updating…' : ''}` : ''))
        .child(Button('analytics-done', t).child('Done').on_click(close)));
  }
}
