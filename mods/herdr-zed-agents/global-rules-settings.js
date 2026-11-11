import { div } from 'gpui-kit';
import { v_flex, h_flex, Editor, EditorState } from 'gpui-base';
import { readTextFile, writeTextFile } from 'herdr';
import { rulesPath } from './components/agents.js';
import { defaultRules } from './global-rules-model.js';
import { Button } from './components/button.js';
import { DialogDescription } from './components/dialog.js';

export const globalRulesSettings = {
  initGlobalRules(cx) {
    if (this.rulesCustom) return;
    this.rulesLoading = true;
    this.rulesCustom = EditorState.new({ value: '', soft_wrap: true });
    this.rulesCustom.on('change', (_event, cx) => { this.rulesSaved = false; cx.notify(); });
    cx.spawn(async cx => {
      try {
        this.rulesOriginal = await readTextFile(rulesPath());
        this.rulesCustom.set_value(this.rulesOriginal ?? defaultRules);
        this.rulesLoaded = true;
      } catch (error) { this.rulesError = error.message; }
      finally { this.rulesLoading = false; cx.notify(); }
    });
  },

  saveGlobalRules(cx) {
    if (this.rulesLoading || this.rulesSaving || !this.rulesLoaded) return;
    const source = this.rulesCustom.value();
    this.rulesSaving = true; this.rulesError = null; cx.notify();
    cx.spawn(async cx => {
      try {
        await writeTextFile(rulesPath(), source, this.rulesOriginal);
        this.rulesOriginal = source; this.rulesSaved = true;
      } catch (error) { this.rulesError = error.message; }
      finally { this.rulesSaving = false; cx.notify(); }
    });
  },

  globalRulesPage(t) {
    if (!this.rulesCustom || this.rulesLoading) return DialogDescription(t).child('Loading global rules…');
    const busy = Boolean(this.rulesSaving);
    return v_flex().id('global-rules-settings').flex_1().min_h(0).gap(12)
      .child(DialogDescription(t).flex_none().child('Edit your custom global instructions for new local agent sessions. Herdr Core, Tasks, MCP installation and Visual Studio guidance are managed in Devkits Rules and Skills. Save to apply.'))
      .child(div().flex_none().text_size(11).text_color(t.muted).child(rulesPath()))
      .child(Editor.new(this.rulesCustom).flex_1().min_h(0).border(1).border_color(t.border).disabled(busy || !this.rulesLoaded))
      .when(Boolean(this.rulesError), el => el.child(div().text_size(12).text_color(t.ansi1).child(this.rulesError)))
      .child(h_flex().flex_none().gap(12).items_center()
        .child(div().flex_1().text_size(12).text_color(t.muted).child(this.rulesSaved ? 'Saved. Applies to new sessions.' : 'Changes apply after saving.'))
        .child(Button('save-global-rules', t).disabled(busy || !this.rulesLoaded)
          .on_click((_event, cx) => this.saveGlobalRules(cx)).child(busy ? 'Saving…' : 'Save changes')));
  },
};
