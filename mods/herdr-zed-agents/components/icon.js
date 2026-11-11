import { svg, image } from 'gpui-kit';

export const glyph = (name, size = 14) => svg(`mods/devkits/assets/icons/${name}.svg`).size(size).flex_none();
// An agent's own icon, or the terminal glyph for the plain terminal launcher.
export const AgentIcon = (agent, t) => !agent ? glyph('terminal', 16) : agent.icon
  ? (agent.tint ? svg(agent.icon).size(16).text_color(t.foreground) : image(agent.icon).size(16)) : glyph('mark', 16);
