import { View } from 'gpui-kit';
import { props } from 'herdr';
import SimulatorPanel, { SimulatorMenu } from './simulator.js';
import XcodeStorage from './xcode-storage.js';

// The devkits layout's simulator block shows the panel; the panel's header opens the device picker.
export default class DevkitsSimulator extends View {
  init(_props, cx) {
    const view = props()?.view;
    this.view = view === 'simulator-devices' ? new SimulatorMenu() : view === 'simulator-storage' ? new XcodeStorage() : new SimulatorPanel();
    this.view.init(cx);
  }

  async close() { await this.view.close?.(); }

  render() { return this.view.render(); }
}
