import { div } from 'gpui-kit';
import { h_flex, v_flex } from 'gpui-base';
import { closeOverlay, openOverlay, spaces as currentSpaces, agents as currentAgents } from 'herdr';
import { boardTheme } from './components/task-theme.js';
import { deleteLocalTask } from './agent-board-state.js';
import { Button } from './components/button.js';

// A modal confirmation, like Linear's Delete issue dialog.
export function openDeleteTask(project, task) {
  return openOverlay({ mod: 'herdr-zed-tasks', kind: 'dialog', modal: true, frame: 'none', width: 440,
    props: { view: 'delete-task', project, task: { gid: task.gid, name: task.name } } });
}

export default class DeleteTask {
  init(options, cx) { this.options = options; this.handle = cx.focus_handle(); this.handle.focus(); }
  dismiss() { closeOverlay(this.options.overlay); }
  confirm(cx) {
    const { project, task } = this.options;
    const current = currentSpaces().find(item => item.id === project.id) || (project.pending ? project : null);
    if (!current || !deleteLocalTask(current, task.gid, currentAgents())) { this.error = 'This task could not be deleted.'; cx.notify(); return; }
    this.dismiss();
  }
  render() {
    const t = boardTheme();
    return v_flex().id('delete-task-dialog').size_full().rounded(12).border(1).border_color(t.border).bg(t.popover).shadow_lg()
      .overflow_hidden().font_family(t.fontFamily).text_color(t.foreground).role('alert_dialog')
      .accessibility_label(`Delete ${this.options.task.name}?`).track_focus(this.handle)
      .on_key_down((event, cx) => {
        if (event.key === 'escape') { cx.stop_propagation(); this.dismiss(); }
        else if (event.key === 'enter') { cx.stop_propagation(); this.confirm(cx); }
      })
      .child(v_flex().flex_1().min_h(0).px(24).pt(20).gap(8)
        .child(div().text_size(15).font_semibold().child('Delete task?'))
        .child(div().text_size(13).text_color(t.muted).child(`“${this.options.task.name}” will be deleted. Conversations, files and subtasks are kept; linked Calendar events stay with an unavailable task link.`))
        .when(Boolean(this.error), el => el.child(div().text_size(12).text_color(t.destructive).child(this.error))))
      .child(h_flex().flex_none().px(24).py(16).gap(8).justify_end()
        .child(Button('delete-task-cancel', t, { variant: 'secondary' }).on_click(() => this.dismiss()).child('Cancel'))
        .child(Button('delete-task-confirm', t, { variant: 'destructive' }).on_click((_event, cx) => this.confirm(cx)).child('Delete')));
  }
}
