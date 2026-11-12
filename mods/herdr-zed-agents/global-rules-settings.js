import { div } from 'gpui-kit';
import { v_flex, h_flex, Editor, EditorState, TextView } from 'gpui-base';
import { readTextFile, writeTextFile } from 'herdr';
import { rulesPath } from './components/agents.js';
import { defaultRules } from './global-rules-model.js';
import { providerDevkits } from './devkits.js';
import { Button } from './components/button.js';
import { glyph, AgentIcon } from './components/icon.js';
import { DialogDescription, DialogFooter } from './components/dialog.js';

const previewProviders = [{ id: 'claude', label: 'Claude Code' }, { id: 'codex', label: 'Codex' }];
// Parts added when a session starts, in injection order after the selected Capabilities.
const launchParts = [
  { id: 'ecc', name: 'ECC selected guidance', source: 'ECC', description: 'Added at launch when ECC is enabled.' },
  { id: 'profile', name: 'Profile instructions', source: 'Profiles', description: 'Added at launch for the chosen Profile.' },
];

// Global Rules lists, in order, what a new local session receives, and edits the Custom section that comes last.
export const globalRulesSettings = {
  initGlobalRules(cx) {
    if (this.rulesCustom) return;
    this.rulesLoading = true; this.rulesProvider = 'claude'; this.rulesKits = {}; this.rulesOpen = null;
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

  globalRulesNavigation(t) {
    return v_flex().gap(2).children(previewProviders.map(item =>
      Button(`global-rules-provider-${item.id}`, t, { variant: 'ghost' }).h(30).w_full().justify_start().gap(8).px(8)
        .bg((this.rulesProvider || 'claude') === item.id ? t.selected : t.popover)
        .on_click((_event, cx) => { this.rulesProvider = item.id; this.rulesOpen = null; cx.notify(); })
        .child(AgentIcon({ icon: `icons/${item.id}.svg` }, t)).child(item.label)));
  },

  // One row per injected section: name, where it comes from, and its text on demand.
  rulesRow(row, index, t) {
    const open = this.rulesOpen === row.id;
    return v_flex().id(`global-rules-row-${row.id}`).border_b(1).border_color(t.border)
      .child(Button(`global-rules-toggle-${row.id}`, t, { variant: 'ghost' }).w_full().h_auto().min_h(44).px(10).py(6).justify_start().gap(10)
        .disabled(!row.body).on_click((_event, cx) => { this.rulesOpen = open ? null : row.id; cx.notify(); })
        .child(div().w(18).flex_none().text_size(11).text_color(t.dim).child(String(index + 1)))
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(h_flex().gap(8).items_center().child(div().text_size(13).child(row.name))
            .child(div().text_size(11).text_color(t.muted).child(row.source)))
          .child(div().text_size(12).text_color(t.muted).child(row.description)))
        .when(Boolean(row.body), el => el.child(glyph(open ? 'chevron-down' : 'chevron-right', 14))))
      .when(open, el => el.child(div().px(38).pb(12)
        .child(TextView.markdown(`global-rules-body-${row.id}`, row.body).text_size(12).selectable(true).scrollable(false))));
  },

  globalRulesPage(t) {
    if (!this.rulesCustom || this.rulesLoading) return DialogDescription(t).child('Loading global rules…');
    const busy = Boolean(this.rulesSaving), provider = this.rulesProvider || 'claude';
    const dirty = this.rulesLoaded && this.rulesCustom.value() !== (this.rulesOriginal ?? defaultRules);
    const rows = [
      ...(this.rulesKits?.[provider]?.items || []).map(item => ({ ...item,
        source: `Capabilities · ${item.kind === 'rule' ? 'Rule' : 'Skill'}${item.source === 'mine' ? ' · Mine' : ''}` })),
      ...launchParts,
    ];
    return v_flex().id('global-rules-settings').flex_1().min_h(0).gap(10)
      .child(DialogDescription(t).flex_none().child('What a new local session receives, in order. Your Custom section comes last.'))
      .child(v_flex().id(`global-rules-outline-${provider}`).flex_1().min_h(0).overflow_y_scroll().border(1).border_color(t.border)
        .children(rows.map((row, index) => this.rulesRow(row, index, t)))
        .child(v_flex().p(10).gap(6)
          .child(h_flex().gap(10).items_center()
            .child(div().w(18).flex_none().text_size(11).text_color(t.dim).child(String(rows.length + 1)))
            .child(div().text_size(13).child('Custom'))
            .child(div().text_size(11).text_color(t.muted).child('Global Rules · yours')))
          .child(Editor.new(this.rulesCustom).h(220).border(1).border_color(t.border).disabled(busy || !this.rulesLoaded))))
      .when(Boolean(this.rulesError), el => el.child(div().text_size(12).text_color(t.ansi1).child(this.rulesError)))
      .child(DialogFooter().flex_none()
        .child(div().flex_1().text_size(12).text_color(t.muted).child(this.rulesSaved ? 'Saved. Applies to new sessions.' : dirty ? 'Unsaved Custom changes.' : ''))
        .child(Button('discard-global-rules', t, { variant: 'secondary' }).disabled(busy || !dirty)
          .on_click((_event, cx) => this.discardGlobalRules(cx)).child('Discard changes'))
        .child(Button('save-global-rules', t).disabled(busy || !dirty)
          .on_click((_event, cx) => this.saveGlobalRules(cx)).child(busy ? 'Saving…' : 'Save changes')));
  },
};
