import { openDataReset } from './reset-dialog.js';
import { div } from 'gpui-kit';
import { h_flex, v_flex } from 'gpui-base';
import { openOverlay, closeOverlay, props, run, shared, setShared, notify, window } from 'herdr';
import { Button, ToolbarButton } from './components/button.js';
import { glyph } from './components/icon.js';
import { Checkbox } from './components/checkbox.js';
import { Switch } from './components/switch.js';
import { DialogTitle, DialogDescription } from './components/dialog.js';
import { AlertDialogContent, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel } from './components/alert-dialog.js';
import { unsavedKey } from './components/extension-contract.js';
import { AUTO_RESUME_KEY } from './thread-identity.js';
import { extensionCatalog, closeWorkspacePanel, extensionEnabled, setExtensionEnabled } from './extensions.js';
import { BuildRulesSettings } from './diff-ignore-settings.js';
import { managedExtensions, extensionKeyOf, packageStatus, packageAbout, placeSwitches, placeSurfaces, ExtensionsNav } from './extensions-manager.js';
import { attachmentsUsage, openAttachmentsFolder, formatBytes } from './components/image-attachments.js';

// Shell-owned management dialogs (ARCHITECTURE §2.1). Preferences, the launcher workflow and Extensions have distinct
// layouts; opening a destination replaces the current management dialog instead of stacking another one.
export const SETTINGS_OVERLAY = 'herdr-zed.settings.overlay';
const SHELL_PAGES = [
  { key: 'general', title: 'General', description: 'Preferences for threads. Files and Changes keep their display options in their own toolbars. Changes save automatically.' },
  { key: 'git', title: 'Git', description: 'Display rules for Changes across all projects; changes save automatically. Commit identity is configured in Changes.' },
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

// Configuration pages from declared settings: enabled extensions (resolved), plus optional extensions that are installed but
// off, so turning one off leaves its settings in place (macOS dims or disables, it does not hide). `indent` identifies a
// sub-page; the UI draws these as contextual tabs.
export const extensionSettingsPages = () => {
  const resolved = extensionCatalog().resolved?.settings || [];
  const off = managedExtensions().filter(entry => entry.settings && entry.id && !entry.unsupported && !entry.error
    && !resolved.some(item => item.mod === entry.mod))
    .map(entry => ({ mod: entry.mod, id: entry.id, view: entry.settings.view, title: entry.settings.title, pages: entry.settings.pages || [] }));
  return [...resolved, ...off].flatMap(entry => [
  { key: extensionPageKey(entry.id), title: entry.title, mod: entry.mod, view: entry.view, page: null, indent: false },
  ...(entry.pages || []).map(page => ({ key: extensionPageKey(entry.id, page.id), title: page.title, mod: entry.mod,
    view: entry.view, page: page.id, indent: true })),
  ]);
};

// What a page key shows: a shell page, an extension's settings page, or (for any optional extension without eligible
// settings, e.g. one that is off) its plain page in the Extensions dialog. Null otherwise.
export function settingsPage(key) {
  const shell = SHELL_PAGES.find(page => page.key === key);
  if (shell) return { ...shell, shell: true };
  const declared = extensionSettingsPages().find(page => page.key === key);
  if (declared) return declared;
  const entry = managedExtensions().find(item => extensionPageKey(extensionKeyOf(item)) === key);
  return entry ? { key, title: entry.title, mod: entry.mod, view: null, page: null, indent: false } : null;
}

// The Extensions dialog's pages: every optional extension, not the launcher workflow.
const managedPage = page => Boolean(page && !page.shell && !launcherSettingsPage(page));
const EXTENSIONS_SELECTED = 'herdr-zed.extensions.selected';
// Opening Extensions shows the extension viewed last, else the first one.
function extensionsLanding() {
  const entries = managedExtensions(), last = shared(EXTENSIONS_SELECTED);
  const entry = entries.find(item => item.mod === last) || entries[0];
  return entry ? extensionPageKey(extensionKeyOf(entry)) : null;
}
// Under an extension's 64px title bar (macOS Settings): one card whose first row is the description with the On/Off
// switch, then a row for its requirement or problem, then its place switches; then its sub-page tabs.
const extensionAboutHeight = (entry, tabs) => {
  if (!entry) return 0;
  const notes = (entry.requires || []).length || entry.error || entry.unsupported ? 1 : 0;
  return 20 + 60 + notes * 33 + placeSurfaces(entry).length * 41 + 2 + (tabs ? 12 + 32 : 0) + 4;
};

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
  const content = page.shell || !page.view
    ? { mod: 'herdr-zed', props: { view: 'settings-page', page: key, context } }
    : { mod: page.mod, props: { view: page.view, embedded: true, page: page.page, context } };
  const subpages = page.shell ? [] : extensionSettingsPages().filter(item => item.mod === page.mod && item.indent);
  const preferences = page.shell && key !== 'extensions', managed = managedPage(page) || key === 'extensions';
  const entry = managedPage(page) ? managedExtensions().find(item => item.mod === page.mod) : null;
  return { kind: 'dialog', modal: true, frame: 'none', width: 1040, height: 0.86,
    layout: { type: 'row', resizable: false, background: 'border', padding: 1, children: [
      ...(preferences ? [{ type: 'block', size: { px: 220 }, content: { mod: 'herdr-zed', props: { view: 'settings-nav', page: key, context } } }] : []),
      ...(managed ? [{ type: 'block', size: { px: 220 }, content: { mod: 'herdr-zed', props: { view: 'extensions-nav', page: key, context } } }] : []),
      { type: 'column', resizable: false, background: 'popover', children: [
        { type: 'block', size: { px: launcherSettingsPage(page) && subpages.length ? 104 : 64 }, content: { mod: 'herdr-zed', props: { view: 'settings-header', page: key, context } } },
        ...(entry ? [{ type: 'block', size: { px: extensionAboutHeight(entry, subpages.length > 0) },
          content: { mod: 'herdr-zed', props: { view: 'settings-header', part: 'about', page: key, context } } }] : []),
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
  if (key === 'extensions') key = extensionsLanding() || key;
  if (!settingsPage(key)) {
    notify({ title: 'Settings unavailable', body: 'That extension is not installed, enabled or available.', level: 'warning' });
    return null;
  }
  const page = settingsPage(key);
  if (managedPage(page)) setShared(EXTENSIONS_SELECTED, page.mod);
  if (!page.shell && !page.indent) {
    key = extensionSettingsPages().find(item => item.mod === page.mod && item.indent)?.key || key;
  }
  closeWorkspacePanel();
  const previous = shared(SETTINGS_OVERLAY);
  setShared(SETTINGS_OVERLAY, null);
  if (previous && shared(unsavedKey(previous))) setShared(unsavedKey(previous), null);
  closeQuietly(previous);
  const id = openOverlay(settingsOverlay(key, settingsContext(project)));
  setShared(SETTINGS_OVERLAY, id);
  return id;
}

// design.md, Dialogs: every dialog closes on Esc. Herdr sends Esc in a layout dialog to its blocks, not to the dialog,
// so each shell block of Settings, Extensions and Agents closes it itself.
export const closeOnEscape = (el, overlay) => el.on_key_down((event, cx) => {
  if (event.key === 'escape') { cx.stop_propagation(); requestSettingsClose(overlay); }
});

// design.md, Unsaved changes (ARCHITECTURE §3.9): whether the open management dialog's page has edits it has not saved.
export const settingsUnsaved = (overlay = shared(SETTINGS_OVERLAY)) => Boolean(overlay && shared(unsavedKey(overlay)));

// Closing (Esc, X, a page asking through herdr-zed.settings-close) or leaving it for another page (nav, tabs) never
// drops edits silently: with unsaved changes the shell asks first. `next` is the page to open instead of closing.
export function requestSettingsClose(overlay = shared(SETTINGS_OVERLAY), next = null) {
  if (settingsUnsaved(overlay)) {
    openOverlay({ mod: 'herdr-zed', kind: 'dialog', frame: 'none', modal: true, width: 440, height: 200,
      props: { view: 'discard-changes', target: overlay, next } });
    return;
  }
  if (next) openSettings(next.key, next.project); else closeSettingsDialog(overlay);
}
// Moving to another page of the open dialog: the same check, then the page opens.
export const navigateSettings = (key, context, overlay) => requestSettingsClose(overlay, { key, project: context });

// "Discard unsaved changes?": Keep editing (also Esc) returns to the page; Discard drops the edits and goes on.
export class DiscardChanges {
  init(cx) { this.handle = cx.focus_handle(); this.handle.focus(); }
  render(t) {
    const { overlay, target, next } = props();
    const keep = () => closeQuietly(overlay);
    const discard = () => {
      setShared(unsavedKey(target), null);
      closeQuietly(overlay);
      if (next) openSettings(next.key, next.project); else closeSettingsDialog(target);
    };
    return AlertDialogContent('discard-changes-dialog', t).accessibility_label('Discard unsaved changes?')
      .track_focus(this.handle).on_key_down((event, cx) => {
        if (event.key === 'escape') keep(); else if (event.key === 'enter') discard(); else return;
        cx.stop_propagation();
      })
      .child(AlertDialogTitle().child('Discard unsaved changes?'))
      .child(AlertDialogDescription(t).child('This page has changes you have not saved. Discarding them cannot be undone.'))
      .child(AlertDialogFooter().children([
        AlertDialogCancel('discard-changes-keep', t).on_click(keep).child('Keep editing'),
        Button('discard-changes-confirm', t, { variant: 'destructive' }).on_click(discard).child('Discard'),
      ]));
  }
}

export function closeSettingsDialog(overlay) {
  const id = overlay || shared(SETTINGS_OVERLAY);
  if (shared(SETTINGS_OVERLAY) === id) setShared(SETTINGS_OVERLAY, null);
  if (id && shared(unsavedKey(id))) setShared(unsavedKey(id), null);
  closeQuietly(id);
}

// Preferences stay here; launcher configuration and extension management open their own dialogs.
export class SettingsNav {
  // The nav takes focus when the dialog opens, so Esc closes it before anything is clicked.
  init(cx) { this.handle = cx.focus_handle(); this.handle.focus(); }
  render(t) {
    const { page, context, overlay } = props();
    const done = () => requestSettingsClose(overlay);
    const unsaved = settingsUnsaved(overlay);
    // Only the open page is selected. Each row's element id carries the overlay it is drawn in: the nav is reopened on every
    // page switch, so a row's hover state must not carry over from the dialog before.
    const entry = (key, label) => {
      const selected = page === key;
      return Button(`settings-nav-${overlay ? `${overlay}-` : ''}${key.replace(/\W/g, '-')}`, t, { variant: 'ghost' })
        .w_full().h(36).px(12).justify_start()
        .bg(selected ? t.selected : t.chrome).text_color(selected ? t.foreground : t.muted)
        .hover(el => el.bg(selected ? t.selected : t.hover))
        .when(selected && unsaved, el => el.border_l(2).border_color(t.ansi1))
        .accessibility_label(selected && unsaved ? `${label}, unsaved changes` : label)
        .on_click(() => { if (page !== key) navigateSettings(key, context, overlay); })
        .child(div().min_w(0).truncate().child(label));
    };
    const divider = () => div().h(1).flex_none().my(6).bg(t.border);
    return closeOnEscape(v_flex().size_full().min_h(0).p(16).gap(4).bg(t.chrome).border_r(1).border_color(t.border)
      .when(Boolean(this.handle), el => el.track_focus(this.handle)), overlay)
      .child(DialogTitle().flex_none().px(12).pt(4).pb(20).child('Settings'))
      .children(SHELL_PAGES.filter(item => item.key !== 'extensions').map(item => entry(item.key, item.title)))
      .child(div().flex_1())
      .child(divider())
      .child(Button('settings-herdr', t, { variant: 'ghost' }).w_full().h(36).px(12).justify_start().text_color(t.muted)
        .on_click(() => { run('app.settings'); done(); }).child('App settings…'))
      .child(div().px(12).text_size(11).text_color(t.muted).child('Appearance, keyboard & terminals'));
  }
}

// The title bar above every Settings page. Preferences and the launcher workflow: the title and the close control.
// An optional extension (design.md, Extensions): title with its requirement or problem, its On/Off switch and close; a
// two-line description; its place switches; and its sub-page tabs.
export class SettingsHeader {
  // Agents' dialog has no nav: its title bar takes focus instead, so Esc closes it too.
  init(cx) {
    this.handle = cx.focus_handle();
    const { page, part } = props();
    if (!part && launcherSettingsPage(settingsPage(page))) this.handle.focus();
  }
  render(t) { return closeOnEscape(this.draw(t).track_focus(this.handle), props().overlay); }
  draw(t) {
    const { page, overlay, context } = props();
    const current = settingsPage(page);
    const catalog = extensionCatalog();
    const entry = managedPage(current) ? managedExtensions(catalog).find(item => item.mod === current.mod) : null;
    const root = current && !current.shell ? extensionSettingsPages().find(item => item.mod === current.mod && !item.indent) : null;
    const subpages = current && !current.shell ? extensionSettingsPages().filter(item => item.mod === current.mod && item.indent) : [];
    const close = ToolbarButton('settings-close', t, { icon: true }).tooltip('Close settings').accessibility_label('Close settings')
      .on_click(() => requestSettingsClose(overlay)).child(glyph('close', 16));
    // design.md, Unsaved changes: the red marker beside the close control while the page has edits to save.
    const unsaved = settingsUnsaved(overlay);
    const marker = div().id('settings-unsaved').flex_none().text_size(12).text_color(t.ansi1).child(unsaved ? 'Unsaved changes' : '');
    const tabs = h_flex().h(36).flex_none().gap(4).items_center()
      .children(subpages.map(item => Button(`settings-subpage-${item.key}`, t, { variant: 'ghost' }).h(30).px(10)
        .bg(page === item.key ? t.selected : t.popover).text_color(page === item.key ? t.foreground : t.muted)
        .when(page === item.key && unsaved, el => el.border_b(2).border_color(t.ansi1))
        .accessibility_label(item.title).on_click(() => { if (page !== item.key) navigateSettings(item.key, context, overlay); }).child(item.title)));
    if (!entry) return v_flex().size_full().min_w(0).px(24).pt(16).gap(8).bg(t.popover).text_color(t.foreground)
      .border_b(1).border_color(t.border)
      .child(h_flex().h(32).flex_none().gap(12).items_center()
        .child(div().flex_1().min_w(0).truncate().font_family('Georgia').text_size(22).child(root?.title || current?.title || 'Settings'))
        .child(marker).child(close))
      .when(subpages.length > 0, el => el.child(tabs));
    const status = packageStatus(entry, catalog), problem = Boolean(status) && !entry.unsupported;
    const needs = (entry.requires || []).map(id => (catalog.packages || []).find(item => item.id === id)?.title || id);
    // Turning it on or off changes nothing else on the page: its settings stay where they are.
    const toggle = (checked, cx) => { setExtensionEnabled(entry.mod, checked); cx.notify(); };
    if (props().part === 'about') {
      const note = status || (needs.length ? `Needs ${needs.join(', ')}` : null);
      return v_flex().size_full().min_w(0).px(24).pt(20).pb(4).gap(12).bg(t.popover).text_color(t.foreground)
        .child(v_flex().id('settings-extension-card').flex_none().border(1).border_color(t.border).bg(t.background)
          .child(h_flex().h(60).px(12).gap(16).items_center()
            .child(div().id('settings-extension-about').flex_1().min_w(0).max_h(34).overflow_hidden().text_size(12).text_color(t.muted)
              .child(packageAbout(entry, catalog)))
            .when(!entry.unsupported, el => el.child(Switch(`settings-enable-${entry.mod}`, extensionEnabled(entry.mod), t)
              .accessibility_label(`${entry.title} enabled`).on_change((checked, cx) => { if (!entry.error) toggle(checked, cx); }))))
          .when(Boolean(note), el => el.child(h_flex().h(32).px(12).items_center().border_t(1).border_color(t.border)
            .child(div().id(`settings-extension-note-${entry.mod}`).min_w(0).truncate().text_size(12).text_color(problem ? t.ansi1 : t.muted)
              .tooltip(note).child(note))))
          .children([placeSwitches(entry, t)].filter(Boolean)))
        .when(subpages.length > 0, el => el.child(tabs.h(32)));
    }
    // The same 64px title bar as every Settings page: the title and the close control.
    return h_flex().size_full().min_w(0).px(24).gap(12).items_center().bg(t.popover).text_color(t.foreground)
      .border_b(1).border_color(t.border)
      .child(div().flex_1().min_w(0).truncate().font_family('Georgia').text_size(22).child(entry.title))
      .child(marker).child(close);
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
    const { page } = props();
    this.page = page;
    if (page === 'git') {
      this.rules = new BuildRulesSettings(); this.rules.init(cx);
    }
    if (page === 'general') this.loadAttachments(cx);
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
    const submitLabel = `Use ${window()?.platform === 'macos' ? '⌘Enter' : 'Ctrl+Enter'} to start threads`;
    return v_flex().flex_1().min_h(0).overflow_y_scroll()
      .child(setting(t, 'Resume agent threads after restart', 'Reopen threads whose terminals were lost on reboot or a crash.',
        Switch('settings-auto-resume', shared(AUTO_RESUME_KEY) !== false, t).accessibility_label('Resume agent threads after restart')
          .on_change((checked, cx) => { setShared(AUTO_RESUME_KEY, checked); cx.notify(); })))
      .child(setting(t, submitLabel, 'When unchecked, Enter starts the thread. Shift+Enter adds a line.',
        Checkbox('settings-ctrl-enter-submit', shared('herdr-zed.ctrl-enter-submit') !== false, t).accessibility_label(submitLabel)
          .on_change((checked, cx) => { setShared('herdr-zed.ctrl-enter-submit', checked); cx.notify(); })))
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

  // An optional extension without settings to show here: one muted line saying why.
  plainExtension(t) {
    const current = settingsPage(this.page);
    const entry = current && managedExtensions().find(item => item.mod === current.mod);
    if (!entry) return div().size_full().bg(t.popover);
    // Nothing to configure: the card above says it all.
    return div().size_full().bg(t.popover);
  }

  render(t) { return closeOnEscape(this.draw(t), props().overlay); }

  draw(t) {
    const page = SHELL_PAGES.find(item => item.key === this.page);
    if (!page) return this.plainExtension(t);
    // Extensions with nothing installed: the dialog has no extension to land on.
    const body = this.page === 'general' ? this.general(t) : this.page === 'git' ? this.git(t) : this.page === 'data' ? this.data(t)
      : div().text_size(12).text_color(t.muted).child('No extensions installed.');
    return v_flex().size_full().min_w(0).min_h(0).p(24).gap(20).bg(t.popover).text_color(t.foreground)
      .child(DialogDescription(t).flex_none().child(page.description))
      .child(body);
  }
}
