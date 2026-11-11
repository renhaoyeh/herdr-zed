// @ts-check
// Opens a provider panel over the shell's work area (ARCHITECTURE §3.7, design.md Dialogs). The shell publishes the
// rectangle; providers and the shell turn { mod, props } into a popup spec with it. The one code path for both.
import { shared, settings } from 'herdr';

export const WORKSPACE_RECT_KEY = 'herdr-zed.workspace-rect';
// The centered fallback while no work area is published (and the default size of a provider panel).
export const WORKSPACE_FALLBACK = { width: 0.9, height: 0.86 };

/** A published rectangle is usable only with a finite origin and a positive size.
 * @param {any} value @returns {{ x: number, y: number, width: number, height: number } | null} */
export function usableWorkspaceRect(value) {
  return value && [value.x, value.y].every(Number.isFinite) && value.width > 0 && value.height > 0
    ? { x: value.x, y: value.y, width: value.width, height: value.height } : null;
}

/**
 * Turns { mod, props, width?, height?, modal? } into an overlay spec. With a published work area: a borderless popup at
 * its top left (device px, scaled by zoom), its published width and height. Without one: a centered dialog of
 * width/height (default 0.9 × 0.86 of the window). The caller opens it with openOverlay.
 * @param {{ mod: string, props: Record<string, unknown>, width?: number, height?: number, modal?: boolean }} spec
 */
export function workspaceOverlay(spec) {
  const rect = usableWorkspaceRect(shared(WORKSPACE_RECT_KEY));
  if (!rect) {
    return { mod: spec.mod, kind: 'dialog', frame: 'none', modal: spec.modal ?? false,
      width: spec.width ?? WORKSPACE_FALLBACK.width, height: spec.height ?? WORKSPACE_FALLBACK.height, props: spec.props };
  }
  const zoom = Number(settings().zoom) || 1;
  return { mod: spec.mod, kind: 'popup', frame: 'none', at: { x: rect.x * zoom, y: rect.y * zoom },
    width: rect.width, height: rect.height, props: spec.props };
}
