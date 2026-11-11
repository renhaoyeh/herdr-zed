import { div } from 'gpui-kit';
import { h_flex, v_flex } from 'gpui-base';
import { closeOverlay, openOverlay } from 'herdr';
import { boardTheme } from './components/task-theme.js';
import { Button } from './components/button.js';

export function openArchiveTask(project, task) {
  return openOverlay({ mod: 'herdr-zed-tasks', kind: 'dialog', modal: true, frame: 'none', width: 560, height: 250,
    props: { view: 'archive-task', project, task: { gid: task.gid, name: task.name } } });
}

export default class ArchiveTask {
  init(options, runtime, cx) { this.options = options; this.runtime = runtime; this.handle = cx.focus_handle(); this.handle.focus(); }
  dismiss() { if (!this.busy) closeOverlay(this.options.overlay); }
  confirm(mode, cx) {
    if (this.busy) return;
    this.busy = true; this.error = null; cx.notify();
    cx.spawn(async cx => {
      try {
        await this.runtime.archiveTask(this.options.project, this.options.task.gid, mode);
        closeOverlay(this.options.overlay);
      } catch (error) { this.error = error.message; }
      finally { this.busy = false; cx.notify(); }
    });
  }
  render() {
    const t = boardTheme();
    return v_flex().id('archive-task-dialog').size_full().border(1).border_color(t.border).bg(t.popover)
      .font_family(t.fontFamily).text_color(t.foreground).role('alert_dialog').accessibility_label('Archive active task')
      .track_focus(this.handle).on_key_down((event, cx) => { if (event.key === 'escape') { cx.stop_propagation(); this.dismiss(); } })
      .child(v_flex().flex_1().min_h(0).p(24).gap(10)
        .child(div().text_size(15).font_semibold().child('Archive active task?'))
        .child(div().text_size(13).text_color(t.muted).child(`“${this.options.task.name}” has an active agent. Keep it running in the background, or stop it before archiving. Its board stage and files are preserved.`))
        .when(Boolean(this.error), el => el.child(div().text_size(12).text_color(t.destructive).child(this.error))))
      .child(h_flex().flex_none().px(24).pb(20).gap(8).justify_end()
        .child(Button('archive-cancel', t, { variant: 'secondary' }).disabled(Boolean(this.busy)).on_click(() => this.dismiss()).child('Cancel'))
        .child(Button('archive-stop', t, { variant: 'secondary' }).disabled(Boolean(this.busy)).on_click((_event, cx) => this.confirm('stop', cx)).child('Stop and archive'))
        .child(Button('archive-background', t).disabled(Boolean(this.busy)).on_click((_event, cx) => this.confirm('background', cx)).child('Keep running and archive')));
  }
}
