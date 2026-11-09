// Shared: edit mods/devkits/components/source-channel.js, then npm run sync:shared.
import { shared, setShared, openOverlay, closeOverlay } from 'herdr';
const storageKey = 'devkits.source-channels.v1';
const read = () => shared(storageKey) || {};
const write = value => setShared(storageKey, JSON.parse(JSON.stringify(value)));
export function createSourceChannel(request) {
  const channel = `source:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const channels = read(); channels[channel] = { request, events: [] }; write(channels); return channel;
}
export function sourceChannel(channel) { return read()[channel] || null; }
export function sourceChannels(receiver) { return Object.entries(read()).filter(([, value]) => value.request.receiver === receiver); }
export function publishSourceEvent(channel, event) {
  const channels = read(), entry = channels[channel];
  if (!entry || (event.type === 'import' && entry.events.some(item => item.type === 'import'))) return false;
  if (event.type === 'binding') entry.request.binding = event.binding;
  entry.events.push(event); write(channels); return true;
}
export function consumeSourceEvents(channel) {
  const channels = read(), entry = channels[channel]; if (!entry?.events.length) return [];
  const events = entry.events; entry.events = []; write(channels); return events;
}
export function closeSourceChannel(channel) { const channels = read(); delete channels[channel]; write(channels); }

// Serializable cross-mod adapter. The source owns its UI/connection; the receiver owns import/bindings.
export function sourceModuleOptions(source, target) {
  const channel = target.channel, context = target.context || {}, stateKey = target.stateKey || `task-source.${source.key}`;
  const getBinding = () => channel ? sourceChannel(channel)?.request.binding || null : shared(`${stateKey}-project`) || target.binding || null;
  const setBinding = (_folder, binding) => channel ? publishSourceEvent(channel, { type: 'binding', binding }) : setShared(`${stateKey}-project`, binding);
  const preferenceKey = suffix => `${suffix === 'field-display' ? `devkits.${source.key}` : stateKey}-${suffix}`;
  return {
    source, importLabel: target.importLabel || 'Import',
    state: { get: suffix => shared(preferenceKey(suffix)), set: (suffix, value) => setShared(preferenceKey(suffix), value) },
    getBinding, setBinding,
    onSelect: project => setBinding(context.folder, { gid: project.gid, name: project.name, workspace: project.workspaceGid,
      ...(source.server ? { server: project.server } : {}) }),
    onImport: channel ? snapshot => { if (publishSourceEvent(channel, { type: 'import', snapshot })) closeOverlay(target.overlay); } : undefined,
    onClose: () => closeOverlay(target.overlay),
    openProjectPicker: (_folder, at) => openOverlay({ mod: `devkits-${source.key}`, kind: 'popup', frame: 'none', width: 360, at,
      props: { ...target, overlay: undefined, view: 'projects' } }),
  };
}
