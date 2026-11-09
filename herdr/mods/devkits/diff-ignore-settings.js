import { div } from 'gpui-kit';
import { Editor, EditorState } from 'gpui-base';
import { props, openOverlay, closeOverlay, writeTextFile, shared, setShared } from 'herdr';
import { buildRulesPath, readBuildRules } from './diff-ignore.js';
import { Button } from './components/button.js';
import { DialogContent, DialogTitle, DialogDescription, DialogFooter } from './components/dialog.js';

export const openBuildRules = () => openOverlay({ mod: 'devkits', kind: 'dialog', frame: 'none',
  modal: false, width: 760, height: 0.8, props: { view: 'diff-ignore-settings' } });

export class BuildRulesSettings {
  init(cx) {
    this.loading = true; this.editor = EditorState.new({ value: '' });
    cx.spawn(async cx => {
      try {
        const rules = await readBuildRules(); this.original = rules.text;
        this.editor.set_value(rules.text);
      } catch (error) { this.error = error.message; }
      finally { this.loading = false; cx.notify(); }
    });
  }

  close() { this.editor?.release(); }

  save(cx) {
    if (this.loading || this.saving || this.original === undefined) return;
    this.saving = true; this.error = null; cx.notify();
    cx.spawn(async cx => {
      try {
        await writeTextFile(buildRulesPath(), this.editor.value(), this.original);
        setShared('devkits.diff-build-rules-revision', (shared('devkits.diff-build-rules-revision') || 0) + 1);
        closeOverlay(props().overlay);
      } catch (error) { this.error = error.message; }
      finally { this.saving = false; cx.notify(); }
    });
  }

  render(t) {
    const cancel = () => { if (!this.saving) closeOverlay(props().overlay); };
    return DialogContent('diff-ignore-settings', t).on_key_down((event, cx) => {
      if (event.key === 'escape') { cx.stop_propagation(); cancel(); }
    })
      .child(DialogTitle().child('Build filter rules'))
      .child(DialogDescription(t).child('Downloaded Visual Studio and Qt templates. Add gitignore patterns or !exceptions here. Applies only to untracked files; lockfile filtering is separate.'))
      .child(div().text_size(11).text_color(t.muted).child(buildRulesPath()))
      .child(Editor.new(this.editor).flex_1().min_h(0).border(1).border_color(t.border))
      .when(this.loading, el => el.child(div().text_size(12).text_color(t.muted).child('Loading rules…')))
      .when(Boolean(this.error), el => el.child(div().text_size(12).text_color(t.ansi1).child(this.error)))
      .child(DialogFooter()
        .child(Button('diff-rules-cancel', t, { variant: 'secondary' }).disabled(Boolean(this.saving)).on_click(cancel).child('Cancel'))
        .child(Button('diff-rules-save', t).disabled(this.loading || this.saving || this.original === undefined)
          .on_click((_event, cx) => this.save(cx)).child(this.saving ? 'Saving…' : 'Save')));
  }
}
