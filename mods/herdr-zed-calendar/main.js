import { View } from 'gpui-kit';
import LocalCalendar from './calendar.js';
import { listTasks, tasksSnapshot, openTaskBoard } from './components/tasks.js';
import { workspacePanel } from './components/workspace-overlay.js';
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
  }
  close() { this.calendar.close(); }
  render() { return workspacePanel(this.calendar.render()); }
}
