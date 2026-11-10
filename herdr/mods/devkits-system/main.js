import { View, div } from 'gpui-kit';
import { props, theme, openOverlay, run, nextCommand } from 'herdr';
import { SystemMonitorCore } from './monitor.js';
import { hardwarePreferences } from './components/system-monitor-model.js';
import { SystemMonitor, systemClientPrefix, systemSnapshotPrefix, systemCommand, systemMessage } from './components/system-monitor.js';
export default class SystemMod extends View {
  init(_props, cx) {
    const target = props() || {};
    this.view = target.view || 'details'; this.clients = new Map();
    this.monitor = new SystemMonitorCore({ details: this.view === 'details', page: target.page, overlay: target.overlay,
      active: () => this.clients.size > 0,
      openDetails: page => openOverlay({ mod: 'devkits-system', kind: 'dialog', frame: 'none', width: 0.9, height: 0.82, props: { view: 'details', page } }),
    });
    if (this.view === 'service') {
      this.monitor.init(cx);
      cx.spawn(async cx => {
        for (;;) {
          const command = await nextCommand();
          if (command === 'reset') { this.monitor.saveHardwarePreference(hardwarePreferences(), cx); continue; }
          const client = systemMessage(command, systemClientPrefix);
          if (!client?.id || !client.receiver) continue;
          const previous = this.clients.get(client.id);
          if (client.active) this.clients.set(client.id, { receiver: client.receiver, until: Date.now() + 5000 });
          else this.clients.delete(client.id);
          if (client.active && !previous && this.monitor.hardwareCheckedAt) this.publish(client.receiver);
        }
      });
      cx.timer.every(1000, cx => {
        for (const [id, client] of this.clients) if (client.until <= Date.now()) this.clients.delete(id);
        if (this.publishedAt === this.monitor.hardwareCheckedAt) return;
        this.publishedAt = this.monitor.hardwareCheckedAt;
        for (const receiver of new Set([...this.clients.values()].map(client => client.receiver))) this.publish(receiver);
      });
    } else {
      if (this.view === 'details') { this.monitor.handle = cx.focus_handle(); this.monitor.handle.focus(); }
      this.client = new SystemMonitor({ receiver: 'devkits-system', onSnapshot: snapshot => {
        this.monitor.hardware = snapshot.data; this.monitor.hardwareHistory = snapshot.history;
        this.monitor.hardwareError = snapshot.error; this.monitor.hardwareCheckedAt = snapshot.updatedAt;
      } });
      this.client.init(cx);
    }
  }
  publish(receiver) {
    if (!this.monitor.hardwareCheckedAt) return;
    const snapshot = this.monitor.snapshot();
    if (snapshot.data) { const { sample, ...data } = snapshot.data; snapshot.data = data; }
    run(receiver + '.' + systemCommand(systemSnapshotPrefix, snapshot));
  }
  close() { this.client?.close(); }
  render() {
    const t = theme();
    if (this.view === 'service') return div().size_full();
    if (this.view === 'details') return this.monitor.renderDetails(t);
    if (this.view === 'inline') return this.monitor.renderInline(t, { id: props()?.id || 'system-inline' });
    return this.monitor.renderWidgets(t, { id: props()?.id || 'system-widgets', style: 'compact', cpuMode: props()?.cpuMode || 'total' });
  }
}
