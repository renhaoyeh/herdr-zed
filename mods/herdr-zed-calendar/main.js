import { View } from 'gpui-kit';
import { props, nextCommand, run } from 'herdr';
import LocalCalendar from './calendar.js';
import { listTasks, tasksSnapshot, openTaskBoard } from './components/tasks.js';
import { workspacePanel, releaseWorkspacePanel } from './components/workspace-overlay.js';
// Calendar reads only the Tasks read model (herdr-zed.tasks.snapshot) and opens the Tasks board popup directly.
export default class CalendarMod extends View {
  init(_props, cx) {
    this.calendar = new LocalCalendar({ tasks: listTasks, deleted: () => tasksSnapshot().deleted || {}, openTask: id => {
      const task = listTasks().find(task => task.id === id);
      if (!task) return false;
      openTaskBoard(task.project, task.gid);
      return true;
    } });
    this.calendar.init(cx);
    const target = props();
    if (target?.overlay && !target.calendarCreate) cx.spawn(async cx => {
      for (;;) {
        const command = await nextCommand();
        if (command === `focus:${target?.overlay}`) { this.calendar.handle.focus(); cx.notify(); }
      }
    });
  }
  close() { releaseWorkspacePanel();
    this.calendar.close();
    const parent = props()?.calendarParent;
    if (parent) run(`herdr-zed-calendar.focus:${parent}`);
  }
  render() { return workspacePanel(this.calendar.render()); }
}
