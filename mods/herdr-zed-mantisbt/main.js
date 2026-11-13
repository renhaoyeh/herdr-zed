import { View, div } from 'gpui-kit';
import { v_flex } from 'gpui-base';
import { props, shared, openOverlay } from 'herdr';
import SourcePanel, { MantisProjectPicker } from './ui.js';
import { MantisSettings } from './settings.js';
import { mantisSource } from './source.js';
import { importTarget, importRequest } from './import-target.js';
import { sourceModuleOptions, publishSourceEvent } from './components/source-channel.js';
import { workspacePanel, releaseWorkspacePanel } from './components/workspace-overlay.js';
import { SourceHub, resolveSourceHub } from './components/source-hub.js';
import { SourceScope } from './components/source-scope.js';
const extensionId = 'mantisbt', catalogKey = 'herdr-zed.extensions.catalog';
export default class SourceMod extends View {
  init(_props, cx) {
    if (props()?.view === 'settings') { this.settings = new MantisSettings(); this.settings.init(cx); return; }
    this.target = { ...(props() || {}), context: props()?.context || { folder: 'source:mantisbt', name: 'MantisBT' } };
    if (typeof this.target.sourceHub === 'string') this.target = resolveSourceHub(this.target);
    this.isPicker = this.target.view === 'projects';
    if (this.target.sourceHub && !this.isPicker) { this.hub = new SourceHub(this.target); this.hub.init(); this.hub.sync(); }
    let options = sourceModuleOptions(mantisSource, this.target);
    if (this.hub) { this.scope = new SourceScope(mantisSource, this.target, () => { this.hub.sync(); return this.hub.projects; }); options = this.scope.options(options); }
    this.browser = this.isPicker ? new MantisProjectPicker(options) : new SourcePanel(options);
    if (this.scope) this.scope.browser = this.browser;
    this.browser.init(...(this.isPicker ? [this.target.context || {}, cx] : [cx]));
    if (!this.isPicker && (!this.hub || this.target.sourceHub.selected === this.hub.selected)) this.browser.handle.focus();
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
    this.browser.onImport = target ? snapshot => {
      this.hub?.sync();
      const request = importRequest(target, { source: extensionId, context: this.target.context, snapshot });
      return openOverlay(request);
    } : undefined;
    return true;
  }
  close() { if (!this.isPicker) releaseWorkspacePanel(); this.scope?.close(); if (this.settings) { this.settings.close(); return; } if (!this.isPicker) { this.browser.dispose(); publishSourceEvent(this.target.channel, { type: 'close' }); } }
  render(cx) {
    if (this.settings) return this.settings.render(cx);
    if (this.isPicker) return this.browser.render();
    if (this.hub) { this.hub.sync(); return workspacePanel(v_flex().size_full().min_h(0)
      .child(this.scope.banner(cx)).child(div().flex_1().min_h(0).child(this.browser.render(this.scope.context(this.target.context), cx)))); }
    return workspacePanel(this.browser.render(this.target.context || null, cx));
  }
}
