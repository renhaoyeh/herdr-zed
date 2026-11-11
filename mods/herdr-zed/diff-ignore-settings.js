import { div } from 'gpui-kit';
import { Editor, EditorState, h_flex, v_flex } from 'gpui-base';
import { props, openOverlay, closeOverlay, writeTextFile, shared, setShared } from 'herdr';
import { readBuildFilters, serializeBuildFilters } from './diff-ignore.js';
import { Button } from './components/button.js';
import { Checkbox } from './components/checkbox.js';
import { DialogContent, DialogTitle, DialogDescription, DialogFooter } from './components/dialog.js';

export const openBuildRules = () => openOverlay({ mod: 'devkits-zed', kind: 'dialog', frame: 'none',
  modal: true, width: 860, height: 0.8, props: { view: 'diff-ignore-settings' } });

const CUSTOM = 'custom';

/** Every Git panel display filter: checked github/gitignore templates with a read-only preview, and Custom rules
    applied last. */
export class BuildRulesSettings {
  init(cx) {
    this.loading = true; this.templates = []; this.checked = new Set(); this.page = CUSTOM;
    this.custom = EditorState.new({ value: '' });
    this.preview = EditorState.new({ value: '', readonly: true });
    cx.spawn(async cx => {
      try {
        const saved = await readBuildFilters();
        this.templates = saved.templates; this.path = saved.path; this.original = saved.original;
        this.checked = new Set(saved.filters.templates);
        this.custom.set_value(saved.filters.custom);
        this.show(saved.filters.templates[0] || this.templates[0]?.file || CUSTOM);
      } catch (error) { this.error = error.message; }
      finally { this.loading = false; cx.notify(); }
    });
  }

  close() { this.custom?.release(); this.preview?.release(); }

  show(page) {
    this.page = page;
    const template = this.templates.find(entry => entry.file === page);
    if (template) this.preview.set_value(template.text);
  }

  save(cx) {
    if (this.loading || this.saving || this.original === undefined) return;
    this.saving = true; this.error = null; cx.notify();
    const text = serializeBuildFilters({ templates: this.templates.map(entry => entry.file).filter(file => this.checked.has(file)),
      custom: this.custom.value() });
    cx.spawn(async cx => {
      try {
        await writeTextFile(this.path, text, this.original);
        setShared('devkits.diff-build-rules-revision', (shared('devkits.diff-build-rules-revision') || 0) + 1);
        closeOverlay(props().overlay);
      } catch (error) { this.error = error.message; }
      finally { this.saving = false; cx.notify(); }
    });
  }

  render(t) {
    const cancel = () => { if (!this.saving) closeOverlay(props().overlay); };
    const page = (key, label) => Button(`diff-rules-page-${key.replace(/\W/g, '-')}`, t, { variant: 'ghost' }).flex_1().min_w(0).h_full().justify_start().px(8)
      .bg(this.page === key ? t.selected : t.popover).text_color(this.page === key ? t.foreground : t.muted)
      .hover(el => el.bg(this.page === key ? t.selected : t.hover))
      .on_click((_event, cx) => { this.show(key); cx.notify(); })
      .child(div().truncate().child(label));
    const template = this.templates.find(entry => entry.file === this.page);
    const lines = text => text.split('\n').filter(line => line.trim() && !line.startsWith('#')).length;
    const item = (key, label, checked, toggle) => h_flex().h(32).flex_none().items_center()
      .child(Checkbox(`diff-rules-use-${key.replace(/\W/g, '-')}`, checked, t).h_full().pl(8).pr(4)
        .accessibility_label(`Use ${label}`).on_change((next, cx) => { toggle(next); this.show(key); cx.notify(); }))
      .child(page(key, label));
    const included = checked => checked ? 'Included.' : 'Not included.';
    return DialogContent('diff-ignore-settings', t).on_key_down((event, cx) => {
      if (event.key === 'escape') { cx.stop_propagation(); cancel(); }
    })
      .child(DialogTitle().flex_none().child('Filter rules'))
      .child(DialogDescription(t).flex_none().child('Hide matching untracked files in the Git panel; tracked changes always stay visible. Custom applies last, so !exceptions override templates.'))
      .child(div().flex_none().text_size(11).text_color(t.muted).child(this.path || ''))
      .child(h_flex().flex_1().min_h(0).items_start().gap(16)
        .child(v_flex().w(200).h_full().flex_none().min_h(0).overflow_y_scroll()
          .children(this.templates.map(entry => item(entry.file, entry.label, this.checked.has(entry.file),
            next => { if (next) this.checked.add(entry.file); else this.checked.delete(entry.file); })))
          .child(div().h(1).my(4).flex_none().bg(t.border))
          .child(h_flex().h(32).flex_none().child(page(CUSTOM, 'Custom'))))
        .child(v_flex().flex_1().h_full().min_w(0).min_h(0).gap(8)
          .child(div().flex_none().text_size(12).text_color(t.muted).child(template
            ? `${template.label}: ${lines(template.text)} rules from github/gitignore, read-only. ${included(this.checked.has(template.file))}`
            : 'Your own gitignore patterns and !exceptions, applied after the checked templates.'))
          .child(Editor.new(this.page === CUSTOM ? this.custom : this.preview).flex_1().min_h(0).border(1).border_color(t.border))))
      .when(this.loading, el => el.child(div().text_size(12).text_color(t.muted).child('Loading rules…')))
      .when(Boolean(this.error), el => el.child(div().text_size(12).text_color(t.ansi1).child(this.error)))
      .child(DialogFooter().flex_none()
        .child(Button('diff-rules-cancel', t, { variant: 'secondary' }).disabled(Boolean(this.saving)).on_click(cancel).child('Cancel'))
        .child(Button('diff-rules-save', t).disabled(this.loading || this.saving || this.original === undefined)
          .on_click((_event, cx) => this.save(cx)).child(this.saving ? 'Saving…' : 'Save')));
  }
}
