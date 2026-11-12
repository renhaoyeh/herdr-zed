import { openDataReset } from './reset-dialog.js';
import { div } from 'gpui-kit';
import { h_flex, v_flex } from 'gpui-base';
import { openOverlay, closeOverlay, props, run, shared, setShared, notify } from 'herdr';
import { Button, ToolbarButton } from './components/button.js';
import { glyph } from './components/icon.js';
import { Switch } from './components/switch.js';
import { DialogTitle, DialogDescription } from './components/dialog.js';
import { AUTO_RESUME_KEY } from './thread-identity.js';
import { extensionCatalog, closeWorkspacePanel, extensionEnabled, setExtensionEnabled } from './extensions.js';
import { BuildRulesSettings } from './diff-ignore-settings.js';
import { ExtensionsManager } from './extensions-manager.js';
import { attachmentsUsage, openAttachmentsFolder, formatBytes } from './components/image-attachments.js';

// Shell-owned management dialogs (ARCHITECTURE §2.1). Preferences, the launcher workflow and Extensions have distinct
// layouts; opening a destination replaces the current management dialog instead of stacking another one.
export const SETTINGS_OVERLAY = 'herdr-zed.settings.overlay';
const SHELL_PAGES = [
  { key: 'general', title: 'General', description: 'Preferences for threads. Files and Changes keep their display options in their own toolbars. Changes save automatically.' },
  { key: 'git', title: 'Git', description: 'Display rules for Changes across all projects. Commit identity is configured in Changes.' },
  { key: 'data', title: 'Data', description: 'Manage data stored by Herdr Zed on this computer.' },
  { key: 'extensions', title: 'Extensions', description: 'Choose what appears in your workspace. Open tools from the main window.' },
];

// Extension pages are keyed `extension:<id>`, so an extension ID can never shadow a shell page. A sub-page (ARCHITECTURE
// §2.1 settings.pages) is `extension:<id>:<page id>`.
export const extensionPageKey = (id, page = null) => page ? `extension:${id}:${page}` : `extension:${id}`;

// The key behind the `herdr-zed.settings:<id>` command: a shell page key (general, git, extensions), an extension ID, or
// `<extension id>:<page id>` for one of its sub-pages.
export const settingsPageKey = id => {
  if (SHELL_PAGES.some(page => page.key === id)) return id;
  const [extension, page] = String(id).split(':');
  return page === undefined ? extensionPageKey(extension) : extensionPageKey(extension, page);
};

// Eligible configuration pages from declared settings. `indent` identifies a sub-page; the UI draws these as contextual tabs.
export const extensionSettingsPages = () => (extensionCatalog().resolved?.settings || []).flatMap(entry => [
  { key: extensionPageKey(entry.id), title: entry.title, mod: entry.mod, view: entry.view, page: null, indent: false },
  ...(entry.pages || []).map(page => ({ key: extensionPageKey(entry.id, page.id), title: page.title, mod: entry.mod,
    view: entry.view, page: page.id, indent: true })),
]);

// What a page key shows: a shell page, or an extension page that is eligible now. Null otherwise.
export function settingsPage(key) {
  const shell = SHELL_PAGES.find(page => page.key === key);
  if (shell) return { ...shell, shell: true };
  return extensionSettingsPages().find(page => page.key === key) || null;
}

// A launcher is the workspace's agent workflow, not an optional tool in the Extensions manager.
// The declared capability determines this; the shell does not name a provider.
export const launcherSettingsPage = page => Boolean(page?.mod && extensionCatalog().resolved?.launcher?.mod === page.mod);

// The project a Settings page is about, captured when the dialog opens (as extension popups capture theirs).
export const settingsContext = project => project
  ? { id: project.id, folder: project.folder, name: project.name, machine: project.machine || null } : null;

// Preferences include their main nav; workflow and extension configuration have dedicated dialogs. All use one shell-owned
// border and header, with providers embedded without another frame, title or close button.
export function settingsOverlay(key, context) {
  const page = settingsPage(key);
  const content = page.shell
    ? { mod: 'herdr-zed', props: { view: 'settings-page', page: key, context } }
    : { mod: page.mod, props: { view: page.view, embedded: true, page: page.page, context } };
  const subpages = page.shell ? [] : extensionSettingsPages().filter(item => item.mod === page.mod && item.indent);
  const preferences = page.shell && key !== 'extensions';
  return { kind: 'dialog', modal: true, frame: 'none', width: 1040, height: 0.86,
    layout: { type: 'row', resizable: false, background: 'border', padding: 1, children: [
      ...(preferences ? [{ type: 'block', size: { px: 220 }, content: { mod: 'herdr-zed', props: { view: 'settings-nav', page: key, context } } }] : []),
      { type: 'column', resizable: false, background: 'popover', children: [
        { type: 'block', size: { px: page.shell ? 64 : launcherSettingsPage(page) ? (subpages.length ? 104 : 64) : subpages.length ? 144 : 96 }, content: { mod: 'herdr-zed', props: { view: 'settings-header', page: key, context } } },
        { type: 'block', content },
      ] },
    ] } };
}

// A dialog that was already closed (Esc closes it natively) is not an error.
function closeQuietly(id) {
  if (!id) return;
  try { closeOverlay(id); } catch { /* already closed */ }
}

// Opens a Settings page. An open Settings dialog is closed first, so switching pages is a reopen.
export function openSettings(key, project = null) {
  if (!settingsPage(key)) {
    notify({ title: 'Settings unavailable', body: 'That extension is not installed, enabled or available.', level: 'warning' });
    return null;
  }
  const page = settingsPage(key);
  if (!page.shell && !page.indent) {
    key = extensionSettingsPages().find(item => item.mod === page.mod && item.indent)?.key || key;
  }
  closeWorkspacePanel();
  const previous = shared(SETTINGS_OVERLAY);
  setShared(SETTINGS_OVERLAY, null);
  closeQuietly(previous);
  const id = openOverlay(settingsOverlay(key, settingsContext(project)));
  setShared(SETTINGS_OVERLAY, id);
  return id;
}

function closeSettingsDialog(overlay) {
  const id = overlay || shared(SETTINGS_OVERLAY);
  if (shared(SETTINGS_OVERLAY) === id) setShared(SETTINGS_OVERLAY, null);
  closeQuietly(id);
}

// Preferences stay here; launcher configuration and extension management open their own dialogs.
export class SettingsNav {
  render(t) {
    const { page, context, overlay } = props();
    const done = () => closeSettingsDialog(overlay);
    // Only the open page is selected. Each row's element id carries the overlay it is drawn in: the nav is reopened on every
    // page switch, so a row's hover state must not carry over from the dialog before.
    const entry = (key, label) => {
      const selected = page === key;
      return Button(`settings-nav-${overlay ? `${overlay}-` : ''}${key.replace(/\W/g, '-')}`, t, { variant: 'ghost' })
        .w_full().h(36).px(12).justify_start()
        .bg(selected ? t.selected : t.chrome).text_color(selected ? t.foreground : t.muted)
        .hover(el => el.bg(selected ? t.selected : t.hover))
        .accessibility_label(label)
        .on_click(() => { if (page !== key) openSettings(key, context); })
        .child(div().min_w(0).truncate().child(label));
    };
    const divider = () => div().h(1).flex_none().my(6).bg(t.border);
    return v_flex().size_full().min_h(0).p(16).gap(4).bg(t.chrome).border_r(1).border_color(t.border)
      .on_key_down((event, cx) => { if (event.key === 'escape') { cx.stop_propagation(); done(); } })
      .child(DialogTitle().flex_none().px(12).pt(4).pb(20).child('Settings'))
      .children(SHELL_PAGES.filter(item => item.key !== 'extensions').map(item => entry(item.key, item.title)))
      .child(div().flex_1())
      .child(divider())
      .child(Button('settings-herdr', t, { variant: 'ghost' }).w_full().h(36).px(12).justify_start().text_color(t.muted)
        .on_click(() => { run('app.settings'); done(); }).child('App settings…'))
      .child(div().px(12).text_size(11).text_color(t.muted).child('Appearance, keyboard & terminals'));
  }
}

// The title bar above every Settings page, shell or extension: the page's title and the one close control.
export class SettingsHeader {
  render(t) {
    const { page, overlay, context } = props();
    const current = settingsPage(page), extension = current && !current.shell;
    const standalone = launcherSettingsPage(current);
    const root = extension ? extensionSettingsPages().find(item => item.mod === current.mod && !item.indent) : null;
    const entry = extension ? extensionCatalog().packages?.find(item => item.mod === current.mod) : null;
    const subpages = extension ? extensionSettingsPages().filter(item => item.mod === current.mod && item.indent) : [];
    return v_flex().size_full().min_w(0).px(24).pt(extension ? 12 : 16).gap(8).bg(t.popover).text_color(t.foreground)
      .border_b(1).border_color(t.border)
      .child(h_flex().h(32).flex_none().gap(12).items_center()
        .when(extension && !standalone, el => el.child(ToolbarButton('settings-back', t, { icon: true }).tooltip('Back to extensions')
          .accessibility_label('Back to extensions').on_click(() => openSettings('extensions', context)).child(glyph('chevron-left', 16))))
        .child(div().flex_1().min_w(0).truncate().font_family('Georgia').text_size(22).child(root?.title || current?.title || 'Settings'))
        .child(ToolbarButton('settings-close', t, { icon: true }).tooltip('Close settings').accessibility_label('Close settings')
          .on_click(() => closeSettingsDialog(overlay)).child(glyph('close', 16))))
      .when(Boolean(entry) && !standalone, el => el.child(h_flex().h(28).flex_none().gap(20).items_center()
        .when(!standalone, row => row.child(h_flex().gap(8).items_center().child(Switch(`settings-enable-${entry.mod}`, extensionEnabled(entry.mod), t)
          .accessibility_label(`${entry.title} enabled`).on_change((checked, cx) => {
            setExtensionEnabled(entry.mod, checked);
            if (!checked) openSettings('extensions', context);
            cx.notify();
          })).child(div().text_size(12).child('Enabled'))))
        .child(new ExtensionsManager().controls(entry, t))))
      .when(subpages.length > 0, el => el.child(h_flex().h(36).flex_none().gap(4).items_center()
        .children(subpages.map(item => Button(`settings-subpage-${item.key}`, t, { variant: 'ghost' }).h(30).px(10)
          .bg(page === item.key ? t.selected : t.popover).text_color(page === item.key ? t.foreground : t.muted)
          .accessibility_label(item.title).on_click(() => { if (page !== item.key) openSettings(item.key, context); }).child(item.title)))));
  }
}

// One row of a General setting: title and description on the left, the control on the right.
const setting = (t, title, description, control) => h_flex().gap(16).py(14).items_center().border_b(1).border_color(t.border)
  .child(v_flex().flex_1().min_w(0).gap(4)
    .child(div().text_size(13).child(title))
    .child(div().text_size(12).text_color(t.muted).child(description)))
  .child(control);

const section = (t, title, description, body) => v_flex().gap(10).min_h(0)
  .child(div().font_family('Georgia').text_size(16).child(title))
  .child(div().text_size(12).text_color(t.muted).child(description))
  .child(body);

// A Settings page in the content area: General, Git or Extensions. Extension pages are hosted by their own mod.
export class SettingsPage {
  init(cx) {
    const { page, context } = props();
    this.page = page;
    if (page === 'git') {
      this.rules = new BuildRulesSettings(); this.rules.init(cx);
    }
    if (page === 'general') this.loadAttachments(cx);
    if (page === 'extensions') {
      this.extensions = new ExtensionsManager({ openSettings: id => openSettings(extensionPageKey(id), context) });
      this.extensions.init(cx);
    }
  }

  close() { this.rules?.close(); }

  // Images pasted into prompts are kept on disk; General shows how much they take and opens their folder.
  loadAttachments(cx) {
    cx.spawn(async cx => {
      try { this.attachments = await attachmentsUsage(); } catch { this.attachments = null; }
      cx.notify();
    });
  }

  general(t) {
    return v_flex().flex_1().min_h(0).overflow_y_scroll()
      .child(setting(t, 'Resume agent threads after restart', 'Reopen threads whose terminals were lost on reboot or a crash.',
        Switch('settings-auto-resume', shared(AUTO_RESUME_KEY) !== false, t).accessibility_label('Resume agent threads after restart')
          .on_change((checked, cx) => { setShared(AUTO_RESUME_KEY, checked); cx.notify(); })))
      .child(setting(t, 'Pasted images', this.attachments
        ? `${this.attachments.count} ${this.attachments.count === 1 ? 'image' : 'images'} · ${formatBytes(this.attachments.bytes)}. Images pasted into New thread and task prompts are kept here; delete any you no longer need.`
        : 'Images pasted into New thread and task prompts are kept in data/herdr-zed/attachments.',
        Button('settings-open-attachments', t, { variant: 'secondary' }).h(28).px(10).accessibility_label('Open the pasted images folder')
          .on_click((_event, cx) => cx.spawn(async cx => { await openAttachmentsFolder(); this.loadAttachments(cx); }))
          .child('Open folder')));
  }

  data(t) {
    return v_flex().flex_1().min_h(0).overflow_y_scroll()
      .child(setting(t, 'Clear all Herdr Zed data',
        'Delete settings, saved sign-ins, dedicated account history, pasted images, Tasks, Calendar, connections and caches. Devkits data and project files are kept.',
        Button('settings-clear-data', t, { variant: 'secondary' }).text_color(t.destructive || t.ansi1)
          .on_click(() => openDataReset()).child('Clear data…')));
  }

  git(t) {
    return v_flex().flex_1().min_h(0).gap(24)
      .child(section(t, 'Display filters · All projects', 'Hide matching untracked files in Changes. These rules affect the display; they do not change your .gitignore. Save to apply.',
        this.rules.render(t)).flex_1());
  }

  render(t) {
    const page = SHELL_PAGES.find(item => item.key === this.page);
    if (!page) return div().size_full().bg(t.popover);
    const body = this.page === 'general' ? this.general(t) : this.page === 'git' ? this.git(t) : this.page === 'data' ? this.data(t) : this.extensions.render(t);
    return v_flex().size_full().min_w(0).min_h(0).p(24).gap(20).bg(t.popover).text_color(t.foreground)
      .child(DialogDescription(t).flex_none().child(page.description))
      .child(body);
  }
}
