// @ts-check
// Opens a workspace panel over the shell's work area (ARCHITECTURE §3.7, design.md Dialogs). The shell publishes the
// rectangle; every workspace panel is one window under one key, so opening another replaces the open one.
import { div } from 'gpui-kit';
import { shared, setShared, settings, openOverlay, closeOverlay, props } from 'herdr';

export const WORKSPACE_RECT_KEY = 'herdr-zed.workspace-rect';
// The window's name: opening a workspace panel with it replaces the open one, in its place.
export const WORKSPACE_PANEL_KEY = 'herdr-zed.workspace-panel';
// The open workspace panel's overlay id. The shell closes it on a project switch or when Settings opens.
export const WORKSPACE_PANEL_OVERLAY = 'herdr-zed.workspace-panel.overlay';
// The centered fallback while no work area is published (and the default size of a provider panel).
export const WORKSPACE_FALLBACK = { width: 0.9, height: 0.86 };

/** A published rectangle is usable only with a finite origin and a positive size.
 * @param {any} value @returns {{ x: number, y: number, width: number, height: number } | null} */
export function usableWorkspaceRect(value) {
  return value && [value.x, value.y].every(Number.isFinite) && value.width > 0 && value.height > 0
    ? { x: value.x, y: value.y, width: value.width, height: value.height } : null;
}

/**
 * Turns { mod, props, width?, height?, modal? } into an overlay spec. With a published work area: a borderless window
 * named WORKSPACE_PANEL_KEY at its top left (device px, scaled by zoom), sized to the published rectangle. Without one: a
 * centered dialog of width/height (default 0.9 × 0.86 of the window). Use openWorkspacePanel to open it.
 * @param {{ mod: string, props: Record<string, unknown>, width?: number, height?: number, modal?: boolean }} spec
 */
export function workspaceOverlay(spec) {
  const rect = usableWorkspaceRect(shared(WORKSPACE_RECT_KEY));
  if (!rect) {
    return /** @type {const} */ ({ mod: spec.mod, kind: 'dialog', frame: 'none', modal: spec.modal ?? false,
      width: spec.width ?? WORKSPACE_FALLBACK.width, height: spec.height ?? WORKSPACE_FALLBACK.height, props: spec.props });
  }
  const zoom = Number(settings().zoom) || 1;
  // A window is dragged by any press its mod doesn't stop; workspacePanel stops them. It doesn't close on a click beside it.
  return /** @type {const} */ ({ mod: spec.mod, kind: 'window', key: WORKSPACE_PANEL_KEY, frame: 'none', at: { x: rect.x * zoom, y: rect.y * zoom },
    width: rect.width, height: rect.height, props: spec.props });
}

/** Opens a workspace panel and records its id (WORKSPACE_PANEL_OVERLAY). Returns the id. */
export function openWorkspacePanel(spec) {
  const id = openOverlay(workspaceOverlay(spec));
  setShared(WORKSPACE_PANEL_OVERLAY, id);
  return id;
}

/**
 * The root of a workspace panel. A window is dragged by any press the mod doesn't stop, and Esc goes to the mod, so the
 * wrapper stops mouse down (the panel can't be dragged) and closes the panel on an Escape its controls did not consume:
 * an inner handler that handles Escape calls cx.stop_propagation(), and the key then never reaches this wrapper.
 * The panel's own focus handle still takes the keyboard (the view focuses it on open).
 * @param {any} el the panel's root element
 */
export function workspacePanel(el) {
  const stop = (_event, cx) => { cx.stop_propagation(); };
  return div().size_full().min_w(0).min_h(0)
    .on_mouse_down('left', stop).on_mouse_down('right', stop).on_mouse_down('middle', stop)
    .on_key_down((event, cx) => {
      if (event.key !== 'escape') return;
      cx.stop_propagation();
      const overlay = props()?.overlay;
      if (overlay) closeOverlay(overlay);
    })
    .child(el);
}
