import { View } from 'gpui-kit';
import { props, closeOverlay } from 'herdr';
import LocalCalendar from './calendar.js';
import { listTasks, requestTaskOpen, taskRequestResult, cancelTaskRequest } from './components/tasks.js';
export default class CalendarMod extends View {
  init(_props, cx) {
    this.calendar = new LocalCalendar({ tasks: listTasks, openTask: id => {
      const task = listTasks().find(task => task.id === id);
      if (!task) return false;
      if (this.pending) cancelTaskRequest(this.pending);
      this.pending = requestTaskOpen(task.project, task.gid, { reply: true }); return null;
    } });
    this.calendar.init(cx);
    cx.timer.every(200, cx => {
      if (!this.pending) return;
      const result = taskRequestResult(this.pending); if (!result) return;
      this.pending = null;
      if (result.ok) closeOverlay(props().overlay);
      else { this.calendar.error = 'This task is no longer available in your projects.'; cx.notify(); }
    });
  }
  close() { if (this.pending) cancelTaskRequest(this.pending); this.calendar.close(); }
  render() { return this.calendar.render(); }
}
