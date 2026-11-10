import { div } from 'gpui-kit';
import { v_flex, h_flex, Editor, EditorState } from 'gpui-base';
import { shared, setShared, readTextFile, writeTextFile } from 'herdr';
import { rulesPath } from './components/agents.js';
import { ruleModules, ruleSettingsKey, ruleSelection, splitRuleGuide, composeRuleGuide, defaultRules } from './global-rules-model.js';
import { Button } from './components/button.js';
import { Checkbox } from './components/checkbox.js';
import { DialogDescription } from './components/dialog.js';

export const globalRulesSettings = {
  initGlobalRules(cx) {
    if (this.rulesCustom) return;
    this.rulesLoading = true;
    this.rulesPage = 'preview';
    this.rulesCustom = EditorState.new({ value: '', soft_wrap: true });
    this.rulesPreview = EditorState.new({ value: '', readonly: true, soft_wrap: true });
    this.rulesCustom.on('change', (_event, cx) => { this.rulesSaved = false; this.refreshRulesPreview(); cx.notify(); });
    cx.spawn(async cx => {
      try {
        this.rulesOriginal = await readTextFile(rulesPath());
        this.rulesGuide = splitRuleGuide(this.rulesOriginal ?? defaultRules);
        this.rulesSelection = ruleSelection(shared(ruleSettingsKey));
        this.rulesCustom.set_value(this.rulesGuide.custom);
        this.refreshRulesPreview();
      } catch (error) { this.rulesError = error.message; }
      finally { this.rulesLoading = false; cx.notify(); }
    });
  },

  refreshRulesPreview() {
    if (!this.rulesGuide) return;
    const guide = { ...this.rulesGuide, custom: this.rulesCustom.value() };
    const item = ruleModules.find(item => item.key === this.rulesPage);
    this.rulesPreview.set_value(item ? guide.sections[item.key] ?? item.text : composeRuleGuide(guide, this.rulesSelection));
  },

  saveGlobalRules(cx) {
    if (this.rulesLoading || this.rulesSaving || !this.rulesGuide) return;
    const guide = { ...this.rulesGuide, custom: this.rulesCustom.value() };
    // Save all sections, including unchecked ones, so disabling a rule never deletes its text.
    const source = composeRuleGuide(guide, ruleSelection());
    const selection = { ...this.rulesSelection };
    this.rulesSaving = true; this.rulesError = null; cx.notify();
    cx.spawn(async cx => {
      try {
        await writeTextFile(rulesPath(), source, this.rulesOriginal);
        setShared(ruleSettingsKey, selection);
        this.rulesOriginal = source; this.rulesGuide = guide; this.rulesSaved = true;
      } catch (error) { this.rulesError = error.message; }
      finally { this.rulesSaving = false; cx.notify(); }
    });
  },

  globalRulesPage(t) {
    if (!this.rulesCustom || this.rulesLoading) return DialogDescription(t).child('Loading global rules…');
    const busy = Boolean(this.rulesSaving), selection = this.rulesSelection || {};
    const pageButton = (key, label) => Button(`rules-view-${key}`, t, { variant: 'ghost' }).flex_1().min_w(0).h(32).px(8).justify_start()
      .bg(this.rulesPage === key ? t.selected : t.popover).disabled(busy)
      .on_click((_event, cx) => { this.rulesPage = key; this.refreshRulesPreview(); cx.notify(); }).child(label);
    const items = [...ruleModules, { key: 'custom', label: 'Custom rules', description: 'Your additional instructions.' }];
    const selected = items.find(item => item.key === this.rulesPage);
    return v_flex().id('global-rules-settings').flex_1().min_h(0).gap(12)
      .child(DialogDescription(t).flex_none().child('Edit your custom global instructions for new local agent sessions. Herdr Core, Tasks, MCP installation and Visual Studio guidance are managed in Devkits Rules and Skills. Save to apply.'))
      .child(div().flex_none().text_size(11).text_color(t.muted).child(rulesPath()))
      .child(h_flex().flex_1().min_h(0).gap(12).items_start()
        .child(v_flex().w(200).h_full().flex_none().gap(4)
          .children(items.map(item => h_flex().h(32).flex_none().items_center()
            .child(Checkbox(`rules-enable-${item.key}`, Boolean(selection[item.key]), t).disabled(busy || !this.rulesGuide)
              .accessibility_label(`Inject ${item.label}`).on_change((checked, cx) => {
                this.rulesSelection[item.key] = checked; this.rulesSaved = false; this.refreshRulesPreview(); cx.notify();
              }))
            .child(pageButton(item.key, item.label))))
          .child(div().h(1).my(4).bg(t.border))
          .child(h_flex().h(32).flex_none().child(pageButton('preview', 'Final preview'))))
        .child(v_flex().flex_1().h_full().min_w(0).min_h(0).gap(8)
          .child(h_flex().h(28).flex_none().items_center().gap(8)
            .child(div().text_size(13).font_semibold().child(selected?.label || 'Final preview'))
            .when(Boolean(selected?.url), row => row.child(Button(`rules-project-${selected.key}`, t, { variant: 'secondary' })
              .h(28).px(10).text_color(t.accent).accessibility_label('Open vs-mcp on GitHub')
              .on_click((_event, cx) => cx.open_url(selected.url)).child('GitHub · vs-mcp ↗'))))
          .child(div().text_size(12).text_color(t.muted).flex_none().child(selected
            ? `${selected.description} ${selection[selected.key] ? 'Included.' : 'Not included.'}${selected.key === 'custom' ? '' : ' Read-only here; edit the Guide file to customize.'}`
            : 'Combined global instructions, in injection order. Profile instructions are appended separately.'))
          .child(Editor.new(this.rulesPage === 'custom' ? this.rulesCustom : this.rulesPreview)
            .flex_1().min_h(0).border(1).border_color(t.border))))
      .when(Boolean(this.rulesError), el => el.child(div().text_size(12).text_color(t.ansi1).child(this.rulesError)))
      .child(h_flex().flex_none().gap(12).items_center()
        .child(div().flex_1().text_size(12).text_color(t.muted).child(this.rulesSaved ? 'Saved. Applies to new sessions.' : 'Changes apply after saving.'))
        .child(Button('save-global-rules', t).disabled(busy || !this.rulesGuide)
          .on_click((_event, cx) => this.saveGlobalRules(cx)).child(busy ? 'Saving…' : 'Save changes')));
  },
};
