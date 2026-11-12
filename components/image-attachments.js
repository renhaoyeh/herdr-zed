// Images pasted into a prompt box (New thread, a task's Continue). A text box cannot read the clipboard's image, so a
// paste that found no text saves it as a PNG under the app's data folder: `image()` shows it from there, and the agent
// gets its absolute path at the end of the prompt and opens it itself.
import { div, image } from 'gpui-kit';
import { h_flex, v_flex } from 'gpui-base';
import { exec, appHome, window, openOverlay, closeOverlay } from 'herdr';
import { ToolbarButton } from './button.js';
import { glyph } from './icon.js';

export const ATTACHMENTS_DIR = 'data/herdr-zed/attachments';
// Exit 3: the clipboard holds no image. The path is passed as an argument, never spliced into the script.
const SAVE_CLIPBOARD = [
  'param($file)',
  'Add-Type -AssemblyName System.Windows.Forms, System.Drawing',
  '$picture = [Windows.Forms.Clipboard]::GetImage()',
  'if (-not $picture) { exit 3 }',
  'New-Item -ItemType Directory -Force -Path (Split-Path $file) | Out-Null',
  '$picture.Save($file, [Drawing.Imaging.ImageFormat]::Png)',
].join('; ');

/**
 * Saves the clipboard's image. Resolves { path (app-relative, for image()), file (absolute, for the agent) }, or null
 * when the clipboard holds no image; rejects with the reason it could not be read.
 */
export async function pasteClipboardImage(services = { exec, appHome, window }) {
  if (services.window()?.platform !== 'windows') throw new Error('Pasting images is available on Windows for now.');
  const path = `${ATTACHMENTS_DIR}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
  const file = `${services.appHome()}/${path}`.replace(/\//g, '\\');
  const result = await services.exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command',
    `& { ${SAVE_CLIPBOARD} } -file '${file.replace(/'/g, "''")}'`], { timeout: 15000 });
  if (result.code === 3) return null;
  if (result.code) throw new Error(result.stderr?.trim() || 'Could not read the image on the clipboard.');
  return { path, file };
}

const attachmentsFolder = services => `${services.appHome()}/${ATTACHMENTS_DIR}`.replace(/\//g, '\\');

/** How many pasted images are kept and their total size in bytes ({ count: 0, bytes: 0 } before the first paste). */
export async function attachmentsUsage(services = { exec, appHome, window }) {
  if (services.window()?.platform !== 'windows') return null;
  const result = await services.exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `& { param($dir) if (-not (Test-Path -LiteralPath $dir)) { '0 0'; return }; $m = Get-ChildItem -LiteralPath $dir -File | Measure-Object -Property Length -Sum; "$($m.Count) $([long]$m.Sum)" } -dir '${attachmentsFolder(services).replace(/'/g, "''")}'`],
    { timeout: 15000 });
  const [count, bytes] = (result.stdout || '').trim().split(/\s+/).map(Number);
  return result.code || !Number.isFinite(count) ? null : { count, bytes: Number.isFinite(bytes) ? bytes : 0 };
}

/** Opens the folder of pasted images in the file manager, creating it first so it always opens. */
export async function openAttachmentsFolder(services = { exec, appHome }) {
  const dir = attachmentsFolder(services);
  await services.exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `& { param($dir) New-Item -ItemType Directory -Force -Path $dir | Out-Null } -dir '${dir.replace(/'/g, "''")}'`], { timeout: 15000 });
  return services.exec('explorer.exe', [dir]).catch(() => null);
}

export const formatBytes = bytes => bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** The prompt with the attached images' paths after it, one per line: Claude Code attaches an image named by its path. */
export const withAttachments = (text, items = []) => !items.length ? text
  : [text.trim(), items.map(item => item.file).join('\n')].filter(Boolean).join('\n\n');

/** Opens an attached image full size in the system's image viewer, where it can be zoomed. */
export const viewAttachment = (item, services = { exec }) =>
  services.exec('explorer.exe', [item.file]).catch(() => null);

// The full-size preview is a dialog of the mod that shows the strip: each such mod routes this view to ImagePreview.
export const IMAGE_PREVIEW_VIEW = 'image-preview';
export const openImagePreview = (mod, item, services = { openOverlay }) => services.openOverlay({ mod, kind: 'dialog', frame: 'none',
  width: 0.8, height: 0.85, props: { view: IMAGE_PREVIEW_VIEW, path: item.path, file: item.file } });

/** The preview dialog: the image fitted to the window, its path, Open in the image viewer and Close (Esc closes too). */
export function ImagePreview(target, t) {
  const close = () => closeOverlay(target.overlay);
  return v_flex().size_full().bg(t.popover).text_color(t.foreground).rounded(8).border(1).border_color(t.border).overflow_hidden()
    .child(h_flex().h(36).flex_none().pl(12).pr(4).gap(4).items_center().border_b(1).border_color(t.border)
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(target.file || ''))
      .child(ToolbarButton('image-preview-open', t, { icon: true }).tooltip('Open in image viewer').accessibility_label('Open in image viewer')
        .on_click(() => viewAttachment(target)).child(glyph('external-link', 14)))
      .child(ToolbarButton('image-preview-close', t, { icon: true }).tooltip('Close preview').accessibility_label('Close preview')
        .on_click(close).child(glyph('close', 14))))
    .child(div().flex_1().min_h(0).p(16).flex().items_center().justify_center().bg(t.background)
      .child(image(target.path).size_full()));
}

/** Thumbnails of the attached images: a click previews one full size; each has a remove button. Null when there are none. */
export function AttachmentStrip(id, items, onRemove, t, mod) {
  if (!items.length) return null;
  return h_flex().id(id).flex_wrap().gap(8).children(items.map((item, index) =>
    div().id(`${id}-view-${index}`).relative().size(64).flex_none().rounded(6).overflow_hidden().border(1).border_color(t.border)
      .cursor_pointer().hover(el => el.border_color(t.accent)).tooltip('Preview').accessibility_label('Preview image')
      .on_click((_event, cx) => { cx.stop_propagation(); openImagePreview(mod, item); })
      .child(image(item.path).size(64))
      .child(ToolbarButton(`${id}-remove-${index}`, t, { icon: true, row: true }).absolute().top(2).right(2).bg(t.background)
        .accessibility_label('Remove image').tooltip('Remove image')
        .on_click((_event, cx) => { cx.stop_propagation(); onRemove(index, cx); })
        .child(glyph('close', 12)))));
}
