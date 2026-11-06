import { View } from 'gpui-kit';
import { props } from 'herdr';
import SimulatorPanel, { SimulatorMenu } from './simulator.js';

// The devkits layout's simulator block shows the panel; the panel's header opens the device picker.
export default class DevkitsSimulator extends View {
  init(_props, cx) {
    this.view = props()?.view === 'simulator-devices' ? new SimulatorMenu() : new SimulatorPanel();
    this.view.init(cx);
  }

  async close() { await this.view.close?.(); }

  render() { return this.view.render(); }
}
