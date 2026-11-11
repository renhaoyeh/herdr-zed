import { View } from 'gpui-kit';
import { props } from 'herdr';
import SourcePanel, { MantisProjectPicker } from './ui.js';
import { mantisSource } from './source.js';
import { sourceModuleOptions, publishSourceEvent } from './components/source-channel.js';
export default class SourceMod extends View {
  init(_props, cx) {
    this.target = { ...(props() || {}), context: props()?.context || { folder: 'source:mantisbt', name: 'MantisBT' } }; this.isPicker = this.target.view === 'projects';
    const options = sourceModuleOptions(mantisSource, this.target);
    this.browser = this.isPicker ? new MantisProjectPicker(options) : new SourcePanel(options);
    this.browser.init(...(this.isPicker ? [this.target.context || {}, cx] : [cx]));
    if (!this.isPicker) cx.timer.every(250, cx => {
      const binding = JSON.stringify(options.getBinding());
      if (binding !== this.bindingSignature) { this.bindingSignature = binding; cx.notify(); }
    });
  }
  close() { if (!this.isPicker) { this.browser.dispose(); publishSourceEvent(this.target.channel, { type: 'close' }); } }
  render(cx) { return this.isPicker ? this.browser.render() : this.browser.render(this.target.context || null, cx); }
}
