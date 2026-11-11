import { View } from 'gpui-kit';
import { props, shared, openOverlay } from 'herdr';
import SourcePanel, { AsanaProjectPicker } from './ui.js';
import { AsanaSettings } from './settings.js';
import { asanaSource } from './source.js';
import { importTarget, importRequest } from './import-target.js';
import { sourceModuleOptions, publishSourceEvent } from './components/source-channel.js';
import { workspacePanel } from './components/workspace-overlay.js';
const extensionId = 'asana', catalogKey = 'herdr-zed.extensions.catalog';
export default class SourceMod extends View {
  init(_props, cx) {
    if (props()?.view === 'settings') { this.settings = new AsanaSettings(); this.settings.init(cx); return; }
    this.target ={ ...(props() || {}), context: props()?.context || { folder: 'source:asana', name: 'Asana' } }; this.isPicker = this.target.view === 'projects';
    const options = sourceModuleOptions(asanaSource, this.target);
    this.browser = this.isPicker ? new AsanaProjectPicker(options) : new SourcePanel(options);
    this.browser.init(...(this.isPicker ? [this.target.context || {}, cx] : [cx]));
    if (!this.isPicker) this.browser.handle.focus();
    if (!this.isPicker) {
      this.bindImport();
      cx.timer.every(250, cx => {
        const binding = JSON.stringify(options.getBinding());
        if (binding !== this.bindingSignature) { this.bindingSignature = binding; cx.notify(); }
        if (this.bindImport()) cx.notify();
      });
    }
  }
  // A browser opened by a receiver keeps the channel flow. A standalone one imports through the catalog's importer, if any.
  bindImport() {
    if (this.target.channel) return false;
    const target = importTarget(shared(catalogKey)), signature = JSON.stringify(target);
    if (signature === this.importSignature) return false;
    this.importSignature = signature;
    this.browser.importLabel = target ? `Import into ${target.title}` : 'Import';
    this.browser.onImport = target ? snapshot => openOverlay(importRequest(target, { source: extensionId, context: this.target.context, snapshot })) : undefined;
    return true;
  }
  close() { if (this.settings) { this.settings.close(); return; } if (!this.isPicker) { this.browser.dispose(); publishSourceEvent(this.target.channel, { type: 'close' }); } }
  render(cx) { if (this.settings) return this.settings.render(cx); return this.isPicker ? this.browser.render() : workspacePanel(this.browser.render(this.target.context || null, cx)); }
}
