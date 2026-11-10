import { View, div } from 'gpui-kit';
import { props, theme } from 'herdr';
import { UsageService } from './service.js';
import { UsageClient } from './components/usage.js';
import { UsageDetails } from './details.js';
import Analytics from './analytics.js';
export default class UsageMod extends View {
  init(_props, cx) {
    this.target = props() || {};
    if (this.target.view === 'service') { this.service = new UsageService(); this.service.init(cx); }
    else if (this.target.view === 'sidebar') { this.client = new UsageClient({ context: () => ({ machine: this.target.machine || null }) }); this.client.init(cx); }
    else if (this.target.view === 'usage-details') { this.details = new UsageDetails(); this.details.init(cx); }
    else { this.analytics = new Analytics(); this.analytics.init(cx); }
  }
  close() { this.client?.close(); for (const monitor of this.service?.monitors.values() || []) monitor.agentClient.close(); }
  render() {
    const t = theme();
    if (this.service) return div().size_full();
    if (this.client) return this.client.render(t);
    if (this.details) return this.details.render(t);
    return this.analytics.render();
  }
}
