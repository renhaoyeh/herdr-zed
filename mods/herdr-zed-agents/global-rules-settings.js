import { div } from 'gpui-kit';
import { v_flex, h_flex, Editor, EditorState, TextView } from 'gpui-base';
import { readTextFile, writeTextFile } from 'herdr';
import { rulesPath } from './components/agents.js';
import { defaultRules, composeSessionRules } from './global-rules-model.js';
import { providerDevkits } from './devkits.js';
import { Button } from './components/button.js';
import { DialogDescription, DialogFooter } from './components/dialog.js';

const previewProviders = [{ id: 'claude', label: 'Claude Code' }, { id: 'codex', label: 'Codex' }];

// Global Rules previews what a new local session receives and edits the user's Custom section,
// which is injected last. Built-in items are chosen in Capabilities.
export const globalRulesSettings = {
  initGlobalRules(cx) {
    if (this.rulesCustom) return;
    this.rulesLoading = true; this.rulesProvider = 'claude'; this.rulesKits = {};
    this.rulesCustom = EditorState.new({ value: '', soft_wrap: true });
    this.rulesCustom.on('change', (_event, cx) => { this.rulesSaved = false; cx.notify(); });
    cx.spawn(async cx => {
      try {
        const [source, claude, codex] = await Promise.all([readTextFile(rulesPath()), providerDevkits('claude'), providerDevkits('codex')]);
        this.rulesOriginal = source; this.rulesKits = { claude, codex };
        this.rulesCustom.set_value(source ?? defaultRules);
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

  discardGlobalRules(cx) {
    if (this.rulesSaving || !this.rulesLoaded) return;
    this.rulesCustom.set_value(this.rulesOriginal ?? defaultRules);
    this.rulesSaved = false; this.rulesError = null; cx.notify();
  },

  globalRulesPage(t) {
    if (!this.rulesCustom || this.rulesLoading) return DialogDescription(t).child('Loading global rules…');
    const busy = Boolean(this.rulesSaving), provider = this.rulesProvider || 'claude';
    const dirty = this.rulesLoaded && this.rulesCustom.value() !== (this.rulesOriginal ?? defaultRules);
    const preview = composeSessionRules(this.rulesCustom.value(), this.rulesKits?.[provider]);
    return v_flex().id('global-rules-settings').flex_1().min_h(0).gap(10)
      .child(DialogDescription(t).flex_none().child('Preview what new local sessions receive. Choose built-in items in Capabilities; ECC guidance and profile instructions are added at launch. Your Custom section comes last.'))
      .child(h_flex().flex_none().gap(4).children(previewProviders.map(item =>
        Button(`global-rules-preview-${item.id}`, t, { variant: 'ghost' }).h(28).bg(provider === item.id ? t.selected : t.popover)
          .on_click((_event, cx) => { this.rulesProvider = item.id; cx.notify(); }).child(item.label))))
      .child(v_flex().id(`global-rules-preview-body-${provider}`).flex_1().min_h(0).overflow_y_scroll().p(12).border(1).border_color(t.border)
        .child(preview
          ? TextView.markdown(`global-rules-preview-text-${provider}`, preview).text_size(13).selectable(true).scrollable(false)
          : div().text_size(12).text_color(t.muted).child('No global rules. Select items in Capabilities or write a Custom section.')))
      .child(h_flex().flex_none().gap(8).items_center()
        .child(div().text_size(12).font_medium().child('Custom'))
        .child(div().text_size(11).text_color(t.muted).child(rulesPath())))
      .child(Editor.new(this.rulesCustom).flex_none().h(160).border(1).border_color(t.border).disabled(busy || !this.rulesLoaded))
      .when(Boolean(this.rulesError), el => el.child(div().text_size(12).text_color(t.ansi1).child(this.rulesError)))
      .child(DialogFooter().flex_none()
        .child(div().flex_1().text_size(12).text_color(t.muted).child(this.rulesSaved ? 'Saved. Applies to new sessions.' : 'Changes apply after saving.'))
        .child(Button('discard-global-rules', t, { variant: 'secondary' }).disabled(busy || !dirty)
          .on_click((_event, cx) => this.discardGlobalRules(cx)).child('Discard changes'))
        .child(Button('save-global-rules', t).disabled(busy || !this.rulesLoaded || !dirty)
          .on_click((_event, cx) => this.saveGlobalRules(cx)).child(busy ? 'Saving…' : 'Save changes')));
  },
};
