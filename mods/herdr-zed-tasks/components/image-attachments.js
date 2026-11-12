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

// AppKit converts clipboard image formats (including TIFF screenshots) to PNG without extra dependencies.
const SAVE_CLIPBOARD_MAC = `
ObjC.import('AppKit');
function run(argv) {
  const picture = $.NSImage.alloc.initWithPasteboard($.NSPasteboard.generalPasteboard);
  if (picture.isNil()) return 'no-image';
  const bitmap = $.NSBitmapImageRep.imageRepWithData(picture.TIFFRepresentation);
  const png = bitmap.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({}));
  if (png.isNil()) throw new Error('Could not convert the clipboard image to PNG.');
  const file = $(argv[0]);
  if (!$.NSFileManager.defaultManager.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(
      file.stringByDeletingLastPathComponent, true, $(), null)) throw new Error('Could not create the images folder.');
  if (!png.writeToFileAtomically(file, true)) throw new Error('Could not save the clipboard image.');
}`;

/**
 * Saves the clipboard's image. Resolves { path (app-relative, for image()), file (absolute, for the agent) }, or null
 * when the clipboard holds no image; rejects with the reason it could not be read.
 */
export async function pasteClipboardImage(services = { exec, appHome, window }) {
  const platform = services.window()?.platform;
  if (platform !== 'windows' && platform !== 'macos') throw new Error('Pasting images is available on Windows and macOS.');
  const path = `${ATTACHMENTS_DIR}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
  const file = platform === 'windows' ? `${services.appHome()}/${path}`.replace(/\//g, '\\') : `${services.appHome()}/${path}`;
  const result = platform === 'macos'
    ? await services.exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', SAVE_CLIPBOARD_MAC, file], { timeout: 15000 })
    : await services.exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command',
    `& { ${SAVE_CLIPBOARD} } -file '${file.replace(/'/g, "''")}'`], { timeout: 15000 });
  if (result.code === 3 || (!result.code && result.stdout?.trim() === 'no-image')) return null;
  if (result.code) throw new Error(result.stderr?.trim() || 'Could not read the image on the clipboard.');
  return { path, file };
}

const attachmentsFolder = services => services.window?.()?.platform === 'macos'
  ? `${services.appHome()}/${ATTACHMENTS_DIR}` : `${services.appHome()}/${ATTACHMENTS_DIR}`.replace(/\//g, '\\');

/** How many pasted images are kept and their total size in bytes ({ count: 0, bytes: 0 } before the first paste). */
export async function attachmentsUsage(services = { exec, appHome, window }) {
  if (services.window()?.platform === 'macos') {
    const result = await services.exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', `
      ObjC.import('Foundation');
      function run(argv) {
        const fm = $.NSFileManager.defaultManager;
        if (!fm.fileExistsAtPath(argv[0])) return '0 0';
        const files = fm.contentsOfDirectoryAtPathError(argv[0], null);
        if (files.isNil()) throw new Error('Could not read the images folder.');
        let count = 0, bytes = 0;
        for (const name of ObjC.deepUnwrap(files)) {
          const attrs = fm.attributesOfItemAtPathError($(argv[0]).stringByAppendingPathComponent(name), null);
          if (attrs.isNil()) throw new Error('Could not read image metadata.');
          if (ObjC.unwrap(attrs.objectForKey($.NSFileType)) !== ObjC.unwrap($.NSFileTypeRegular)) continue;
          count++; bytes += Number(ObjC.unwrap(attrs.objectForKey($.NSFileSize)));
        }
        return count + ' ' + bytes;
      }`, attachmentsFolder(services)], { timeout: 15000 });
    const [count, bytes] = (result.stdout || '').trim().split(/\s+/).map(Number);
    return result.code || !Number.isFinite(count) || !Number.isFinite(bytes) ? null : { count, bytes };
  }
  if (services.window()?.platform !== 'windows') return null;
  const result = await services.exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `& { param($dir) if (-not (Test-Path -LiteralPath $dir)) { '0 0'; return }; $m = Get-ChildItem -LiteralPath $dir -File | Measure-Object -Property Length -Sum; "$($m.Count) $([long]$m.Sum)" } -dir '${attachmentsFolder(services).replace(/'/g, "''")}'`],
    { timeout: 15000 });
  const [count, bytes] = (result.stdout || '').trim().split(/\s+/).map(Number);
  return result.code || !Number.isFinite(count) ? null : { count, bytes: Number.isFinite(bytes) ? bytes : 0 };
}

/** Opens the folder of pasted images in the file manager, creating it first so it always opens. */
export async function openAttachmentsFolder(services = { exec, appHome, window }) {
  const dir = attachmentsFolder(services);
  if (services.window?.()?.platform === 'macos') {
    const result = await services.exec('/bin/mkdir', ['-p', dir], { timeout: 15000 });
    if (result.code) throw new Error(result.stderr?.trim() || 'Could not create the images folder.');
    return services.exec('/usr/bin/open', [dir]).catch(() => null);
  }
  await services.exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `& { param($dir) New-Item -ItemType Directory -Force -Path $dir | Out-Null } -dir '${dir.replace(/'/g, "''")}'`], { timeout: 15000 });
  return services.exec('explorer.exe', [dir]).catch(() => null);
}

export const formatBytes = bytes => bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** The prompt with the attached images' paths after it, one per line: Claude Code attaches an image named by its path. */
export const withAttachments = (text, items = []) => !items.length ? text
  : [text.trim(), items.map(item => item.file).join('\n')].filter(Boolean).join('\n\n');

/** Opens an attached image full size in the system's image viewer, where it can be zoomed. */
export const viewAttachment = (item, services = { exec, window }) =>
  services.exec(services.window?.()?.platform === 'macos' ? '/usr/bin/open' : 'explorer.exe', [item.file]).catch(() => null);

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
