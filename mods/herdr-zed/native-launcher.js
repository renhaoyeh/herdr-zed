import { programInScope } from './components/session-model.js';
import { div } from 'gpui-kit';
import { v_flex } from 'gpui-base';
import { appHome, knownAgents, props, closeOverlay, notify } from 'herdr';
import { DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel } from './components/dropdown-menu.js';
import { AgentIcon } from './components/icon.js';
import { createNativeThread } from './native-threads.js';

export class NativeLauncher {
  init(cx) {
    this.target = props(); this.items = [null]; this.index = 0;
    this.handle = cx.focus_handle(); this.handle.focus(); this.loading = true;
    cx.spawn(async cx => {
      try { this.items = [null, ...(await knownAgents({ on: this.target.machine })).filter(agent => agent.installed && programInScope(agent, appHome()))]; }
      catch { this.error = 'Could not discover installed programs.'; }
      this.loading = false; cx.notify();
    });
  }
  choose(item) {
    try { createNativeThread(item, this.target); }
    catch (error) { notify({ title: 'Could not start session', body: error.message, level: 'error' }); }
  }
  render(t) {
    return DropdownMenuContent('native-launcher', undefined, t).max_h(440).track_focus(this.handle)
      .on_key_down((event, cx) => {
        if (event.key === 'escape') closeOverlay(this.target.overlay);
        else if (event.key === 'enter') this.choose(this.items[this.index]);
        else if (event.key === 'down' || event.key === 'up') { this.index = (this.index + (event.key === 'up' ? -1 : 1) + this.items.length) % this.items.length; cx.notify(); }
        else return;
        cx.stop_propagation();
      })
      .child(DropdownMenuLabel(t).child('NEW THREAD'))
      .child(v_flex().id('native-programs').flex_none().h(Math.min(352, this.items.length * 32)).overflow_y_scrollbar().children(this.items.map((agent, index) =>
        DropdownMenuItem(`native-program-${agent?.key || 'terminal'}`, t).bg(index === this.index ? t.selected : t.popover)
          .on_hover((inside, cx) => { if (inside) { this.index = index; cx.notify(); } })
          .on_click(() => this.choose(agent))
          .child(div().size(16).flex_none().flex().items_center().justify_center().text_color(t.muted).child(AgentIcon(agent, t)))
          .child(div().flex_1().min_w(0).truncate().child(agent?.name || 'Terminal')))))
      .when(this.loading || this.error, el => el.child(div().px(8).py(6).text_size(12).text_color(t.muted)
        .child(this.error || 'Looking for programs…')));
  }
}
