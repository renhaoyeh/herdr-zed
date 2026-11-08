import { View } from 'gpui-kit';
import { props } from 'herdr';
import SourcePanel, { AsanaProjectPicker } from './ui.js';
import { asanaSource } from './source.js';
import { sourceModuleOptions, publishSourceEvent } from './components/source-channel.js';
export default class SourceMod extends View {
  init(_props, cx) {
    this.target = { ...(props() || {}), context: props()?.context || { folder: 'source:asana', name: 'Asana' } }; this.isPicker = this.target.view === 'projects';
    const options = sourceModuleOptions(asanaSource, this.target);
    this.browser = this.isPicker ? new AsanaProjectPicker(options) : new SourcePanel(options);
    this.browser.init(...(this.isPicker ? [this.target.context || {}, cx] : [cx]));
    if (!this.isPicker) cx.timer.every(250, cx => {
      const binding = JSON.stringify(options.getBinding());
      if (binding !== this.bindingSignature) { this.bindingSignature = binding; cx.notify(); }
    });
  }
  close() { if (!this.isPicker) publishSourceEvent(this.target.channel, { type: 'close' }); }
  render(cx) { return this.isPicker ? this.browser.render() : this.browser.render(this.target.context || null, cx); }
}
