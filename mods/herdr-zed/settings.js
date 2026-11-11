import { div } from 'gpui-kit';
import { h_flex, v_flex } from 'gpui-base';
import { openOverlay, closeOverlay, props, run, shared, setShared, notify } from 'herdr';
import { Button, ToolbarButton } from './components/button.js';
import { glyph } from './components/icon.js';
import { Switch } from './components/switch.js';
import { ToggleGroup, ToggleGroupItem } from './components/toggle-group.js';
import { DialogTitle, DialogDescription } from './components/dialog.js';
import { AUTO_RESUME_KEY } from './thread-identity.js';
import { extensionCatalog } from './extensions.js';
import { BuildRulesSettings } from './diff-ignore-settings.js';
import { GitAuthorSettings } from './git-author-settings.js';
import { ExtensionsManager } from './extensions-manager.js';

// The one Settings dialog (ARCHITECTURE §2.1): a nav column and a page in one layout. Switching pages reopens it.
export const SETTINGS_OVERLAY = 'herdr-zed.settings.overlay';
const SHELL_PAGES = [
  { key: 'general', title: 'General', description: 'Herdr-zed behavior. Changes apply immediately.' },
  { key: 'git', title: 'Git', description: 'Changes filters, and the commit author of the repository in view.' },
  { key: 'extensions', title: 'Manage extensions', description: 'Manage installed workspace extensions. Changes apply immediately.' },
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

// Eligible extension pages only: the catalog's resolved list holds enabled, error-free, available packages that declare
// `settings`. Each entry is followed by its sub-pages (`indent`), in declaration order.
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

// The project a Settings page is about, captured when the dialog opens (as extension popups capture theirs).
export const settingsContext = project => project
  ? { id: project.id, folder: project.folder, name: project.name, machine: project.machine || null } : null;

// Layout of the dialog: the nav block (shell props only) beside the page column. The column is a title bar with the
// one close control, then the page. Shell pages are the shell's own views; extension pages are the provider's settings
// view, embedded so it draws no frame, title or close button of its own.
export function settingsOverlay(key, context) {
  const page = settingsPage(key);
  const content = page.shell
    ? { mod: 'herdr-zed', props: { view: 'settings-page', page: key, context } }
    : { mod: page.mod, props: { view: page.view, embedded: true, page: page.page, context } };
  return { kind: 'dialog', modal: true, frame: 'none', width: 1040, height: 0.86,
    layout: { type: 'row', children: [
      { type: 'block', size: { px: 220 }, content: { mod: 'herdr-zed', props: { view: 'settings-nav', page: key, context } } },
      { type: 'column', background: 'popover', children: [
        { type: 'block', size: { px: 32 }, content: { mod: 'herdr-zed', props: { view: 'settings-header', page: key } } },
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

const heading = (t, label) => div().px(10).pt(14).pb(4).text_size(11).text_color(t.muted).child(label);

// Left column: Workspace pages, eligible extension pages, then Herdr settings. Esc and the header X close the dialog.
export class SettingsNav {
  render(t) {
    const { page, context, overlay } = props();
    const done = () => closeSettingsDialog(overlay);
    // Only the open page is selected. Each row's element id carries the overlay it is drawn in: the nav is reopened on every
    // page switch, so a row's hover state must not carry over from the dialog before.
    const entry = (key, label, indent = false) => {
      const selected = page === key;
      return Button(`settings-nav-${overlay ? `${overlay}-` : ''}${key.replace(/\W/g, '-')}`, t, { variant: 'ghost' })
        .w_full().h(32).px(indent ? 24 : 10).justify_start()
        .bg(selected ? t.selected : t.popover).text_color(selected ? t.foreground : t.muted)
        .hover(el => el.bg(selected ? t.selected : t.hover))
        .accessibility_label(label)
        .on_click(() => openSettings(key, context))
        .child(div().min_w(0).truncate().child(label));
    };
    const extensions = extensionSettingsPages();
    // design.md, Separators: a 1px divider between Workspace, Extensions and Herdr settings.
    const divider = () => div().h(1).flex_none().my(6).bg(t.border);
    return v_flex().size_full().min_h(0).p(12).gap(2).bg(t.popover).border(1).border_color(t.border)
      .on_key_down((event, cx) => { if (event.key === 'escape') { cx.stop_propagation(); done(); } })
      .child(DialogTitle().flex_none().px(10).pt(4).pb(8).child('Settings'))
      .child(heading(t, 'Workspace'))
      .children(SHELL_PAGES.map(item => entry(item.key, item.title)))
      .when(extensions.length > 0, el => el.child(divider()).child(heading(t, 'Extensions'))
        .children(extensions.map(item => entry(item.key, item.title, item.indent))))
      .child(div().flex_1())
      .child(divider())
      .child(Button('settings-herdr', t, { variant: 'ghost' }).w_full().h(32).px(10).justify_start().text_color(t.muted)
        .on_click(() => { run('app.settings'); done(); }).child('Herdr settings…'));
  }
}

// The title bar above every Settings page, shell or extension: the page's title and the one close control.
export class SettingsHeader {
  render(t) {
    const { page, overlay } = props();
    return h_flex().size_full().min_w(0).px(24).gap(12).items_center().bg(t.popover).text_color(t.foreground)
      .border_t(1).border_r(1).border_b(1).border_color(t.border)
      .child(div().flex_1().min_w(0).truncate().font_family('Georgia').text_size(16).child(settingsPage(page)?.title || 'Settings'))
      .child(ToolbarButton('settings-close', t, { icon: true }).accessibility_label('Close settings')
        .on_click(() => closeSettingsDialog(overlay)).child(glyph('close', 14)));
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
      if (context?.folder) { this.author = new GitAuthorSettings({ folder: context.folder, machine: context.machine || null }); this.author.init(cx); }
    }
    if (page === 'extensions') { this.extensions = new ExtensionsManager(); this.extensions.init(cx); }
  }

  close() { this.rules?.close(); this.author?.close(); }

  general(t) {
    const split = shared('herdr-zed.diff-layout') === 'split';
    const choose = (key, value) => (pressed, cx) => { if (pressed) setShared(key, value); cx.notify(); };
    return v_flex().flex_1().min_h(0).overflow_y_scroll()
      .child(setting(t, 'Resume agent threads after restart', 'Reopen threads whose terminals were lost on reboot or a crash.',
        Switch('settings-auto-resume', shared(AUTO_RESUME_KEY) !== false, t).accessibility_label('Resume agent threads after restart')
          .on_change((checked, cx) => { setShared(AUTO_RESUME_KEY, checked); cx.notify(); })))
      .child(setting(t, 'Wrap tabs', 'Let editor and file tabs wrap onto several lines.',
        Switch('settings-files-wrap-tabs', shared('herdr-zed.files-wrap-tabs') === true, t).accessibility_label('Wrap tabs')
          .on_change((checked, cx) => { setShared('herdr-zed.files-wrap-tabs', checked); cx.notify(); })))
      .child(setting(t, 'Wrap diff lines', 'Wrap long lines in the Changes diff.',
        Switch('settings-diff-wrap', shared('herdr-zed.diff-wrap') !== false, t).accessibility_label('Wrap diff lines')
          .on_change((checked, cx) => { setShared('herdr-zed.diff-wrap', checked); cx.notify(); })))
      .child(setting(t, 'Default diff layout', 'Unified or side by side. A diff can still be switched in its own toolbar.',
        ToggleGroup('settings-diff-layout', 'Default diff layout', t)
          .child(ToggleGroupItem('settings-diff-unified', !split, true, t).accessibility_label('Unified')
            .on_change(choose('herdr-zed.diff-layout', 'unified')).child('Unified'))
          .child(ToggleGroupItem('settings-diff-split', split, false, t).accessibility_label('Split')
            .on_change(choose('herdr-zed.diff-layout', 'split')).child('Split'))));
  }

  git(t) {
    return v_flex().flex_1().min_h(0).gap(24)
      .child(section(t, 'Filter rules', 'Hide matching untracked files in Changes; tracked changes always stay visible. Custom applies last, so !exceptions override templates.',
        this.rules.render(t)).flex_1())
      .child(section(t, 'Commit author', 'Set the name and email for future commits in this repository. Existing commits stay unchanged.',
        this.author ? this.author.render(t)
          : div().text_size(12).text_color(t.muted).child('Open a project to set the commit author of its repository.')));
  }

  render(t) {
    const page = SHELL_PAGES.find(item => item.key === this.page);
    if (!page) return div().size_full().bg(t.popover);
    const body = this.page === 'general' ? this.general(t) : this.page === 'git' ? this.git(t) : this.extensions.render(t);
    return v_flex().size_full().min_w(0).min_h(0).p(24).gap(20).bg(t.popover).text_color(t.foreground)
      .border_r(1).border_b(1).border_color(t.border)
      .child(DialogDescription(t).flex_none().child(page.description))
      .child(body);
  }
}
