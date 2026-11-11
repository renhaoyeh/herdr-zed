// Shared: edit components/task-theme.js, then npm run sync:shared.
import { settings, fonts } from 'herdr';

let boardFont;

// Measured from Linear's signed-in Light and Dark interfaces, including hovered
// and selected controls. Keep interaction surfaces separate from input borders.
export function boardTheme() {
  const dark = settings().dark;
  if (!boardFont) {
    const installed = fonts();
    boardFont = ['Inter Variable', 'Inter', 'SF Pro Display', 'SF Pro Text', 'Arial'].find(font => installed.includes(font)) || 'Arial';
  }
  return { appearance: 'linear', fontFamily: boardFont,
    background: dark ? '#121213' : '#f9f9fa', chrome: dark ? '#161617' : '#efeff0',
    popover: dark ? '#1c1c1d' : '#ffffff', foreground: dark ? '#ffffff' : '#1b1b1b',
    secondary: dark ? '#e3e4e6' : '#2f2f31', muted: dark ? '#959597' : '#5c5c5e',
    border: dark ? '#232426' : '#e4e4e4', input: dark ? '#28282b' : '#d3d3d3',
    control: dark ? '#1c1c1d' : '#ffffff', controlBorder: dark ? '#303032' : '#dedede',
    hover: dark ? '#232424' : '#f0f0f1', selected: dark ? '#29292b' : '#ececed',
    menuHover: dark ? '#29292b' : '#f0f0f1',
    card: dark ? '#1a1a1b' : '#ffffff', cardHover: dark ? '#212223' : '#f5f5f5',
    cardBorder: dark ? '#ffffff0c' : '#00000008',
    cardSelected: dark ? '#242426' : '#ededee', cardSelectedBorder: dark ? '#454548' : '#c8c8ca',
    solid: '#5e6ad2', solidHover: '#6874dc', solid_foreground: '#ffffff', destructive: dark ? '#e57878' : '#cf4343' };
}
