import { nextCommand } from 'herdr';
import { UsageMonitor } from './monitor.js';
import { usageMessage, usageClientPrefix, usageRefreshPrefix } from '../components/usage.js';
export class UsageService {
  constructor() { this.clients = new Map(); this.monitors = new Map(); }
  active(machine) { return [...this.clients.values()].some(client => client.machine === machine && client.until > Date.now()); }
  monitor(machine) {
    const key = JSON.stringify(machine);
    if (!this.monitors.has(key)) this.monitors.set(key, new UsageMonitor({ machine, active: () => this.active(machine) }));
    return this.monitors.get(key);
  }
  init(cx) {
    cx.spawn(async cx => {
      for (;;) {
        const command = await nextCommand(), client = usageMessage(command, usageClientPrefix);
        if (client?.id && (client.machine === null || typeof client.machine === 'string')) {
          const previous = this.clients.get(client.id);
          if (client.active) { this.clients.set(client.id, { machine: client.machine, until: Date.now() + 5000 }); this.monitor(client.machine).refreshUsage(cx, false); }
          else this.clients.delete(client.id);
          if (previous && (!client.active || previous.machine !== client.machine)) this.monitor(previous.machine).refreshUsage(cx, false);
        }
        const refresh = usageMessage(command, usageRefreshPrefix), target = refresh && this.clients.get(refresh.id);
        if (target && target.until > Date.now()) this.monitor(target.machine).refreshUsage(cx, true, true);
      }
    });
    cx.timer.every(1000, cx => {
      for (const [id, client] of this.clients) if (client.until <= Date.now()) this.clients.delete(id);
      for (const monitor of this.monitors.values()) monitor.refreshUsage(cx, false);
    });
    cx.timer.every(60000, cx => { for (const monitor of this.monitors.values()) monitor.refreshUsage(cx); });
  }
}
