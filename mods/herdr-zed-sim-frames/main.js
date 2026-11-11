import { View, div } from 'gpui-kit';

// Holds the Simulator panel's frames. Herdr refreshes images only inside mod folders, and a write
// inside the herdr-zed-simulator mod would reload it, so frames live here. This view is never placed.
export default class SimulatorFrames extends View {
  render() { return div(); }
}
