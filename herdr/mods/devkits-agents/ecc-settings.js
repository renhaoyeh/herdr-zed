import { Input } from './components/input.js';
import { div } from 'gpui-kit';
import { h_flex, v_flex, InputState, TextView } from 'gpui-base';
import { readTextFile, writeTextFile, appHome, exec } from 'herdr';
import { mkdir, unlink } from 'fs/promises';
import { eccPath } from './ecc.js';
import { parseEcc, eccGroups, eccItemEnabled, chooseEccItem } from './ecc-model.js';
import { Switch } from './components/switch.js';
import { Select, SelectState } from './components/select.js';
import { Button } from './components/button.js';
import { glyph, AgentIcon } from './components/icon.js';
import { DialogTitle, DialogDescription, DialogFooter } from './components/dialog.js';

const eccProviderName = provider => provider === 'claude' ? 'Claude Code' : 'Codex';
const eccRuntimePath = () => `${appHome()}/mods/devkits-agents/ecc-runtime.js`;
const eccPageSize = 24;
const eccCategoryIcons = { rules: 'list-todo', agents: 'agent', skills: 'book-open', commands: 'terminal',
  hooks: 'refresh-cw', mcp: 'external-link', contexts: 'columns-3', workflows: 'git-graph' };
const eccDescriptionMarkdown = (item, text) => ['hooks', 'mcp', 'workflows'].includes(item.group)
  ? `\`\`\`${item.path.endsWith('.js') ? 'javascript' : 'json'}\n${text}\n\`\`\``
  : text.replace(/^---\r?\n[\s\S]*?\r?\n---\s*/, '');

export const eccSettings = {
  initEcc(cx) {
    this.eccLoading = true; this.eccSaving = false; this.eccError = null; this.eccDraft = null; this.eccSaved = false; this.eccClosed = false;
    this.eccTab = 'overview'; this.eccProvider = 'claude'; this.eccSection = 'skills'; this.eccListPage = 0;
    this.eccCatalog = null; this.eccCatalogError = null; this.eccSelected = null; this.eccShowSource = false;
    this.eccSource = `${appHome()}/data/devkits/ecc-source`;
    this.eccSearch = InputState.new({ placeholder: 'Search names, descriptions, languages or modules…' });
    this.eccSearch.on('change', (_event, cx) => { this.eccListPage = 0; cx.notify(); });
    this.eccSelect = new SelectState(cx);
    cx.spawn(async cx => {
      try {
        this.eccOriginal = await readTextFile(eccPath());
        if (this.eccClosed) return;
        this.eccDraft = parseEcc(this.eccOriginal);
        this.eccDraft.source = this.eccSource;
        this.loadEccCatalog(cx);
      } catch (error) { this.eccError = error.message; }
      finally { this.eccLoading = false; if (!this.eccClosed) cx.notify(); }
    });
  },
  loadEccCatalog(cx) {
    if (this.eccSaving || this.eccClosed) return;
    const source = this.eccSource, request = this.eccCatalogRequest = (this.eccCatalogRequest || 0) + 1;
    this.eccCatalogLoading = true; this.eccCatalogError = null; this.eccCatalog = null;
    this.eccShowSource = false; this.eccDetailText = null; cx.notify();
    this.eccDetailRequest = (this.eccDetailRequest || 0) + 1;
    cx.spawn(async cx => {
      try {
        const result = await exec('node', [eccRuntimePath(), 'catalog', source], { timeout: 60000 });
        if (result.code !== 0) throw new Error(result.stderr?.trim() || 'Could not read the ECC source.');
        const catalog = JSON.parse(result.stdout);
        if (this.eccClosed || request !== this.eccCatalogRequest) return;
        this.eccCatalog = catalog; this.eccCatalogInput = source;
        this.eccSelected = catalog.items.find(item => item.id === this.eccSelected)?.id || null;
      } catch (error) { if (!this.eccClosed && request === this.eccCatalogRequest) this.eccCatalogError = error.message; }
      finally { if (!this.eccClosed && request === this.eccCatalogRequest) { this.eccCatalogLoading = false; cx.notify(); } }
    });
  },
  selectEccSection(provider, section, cx) {
    this.eccTab = provider; this.eccProvider = provider; this.eccSection = section;
    this.eccSearch.set_value(''); this.eccListPage = 0; this.eccSelected = null; this.eccShowSource = false; this.eccDetailText = null; cx.notify();
  },
  selectEccItem(item, cx) {
    this.eccSelected = item.id; this.eccShowSource = false; this.eccDetailText = null;
    this.eccDetailRequest = (this.eccDetailRequest || 0) + 1; cx.notify();
  },
  changeEccItem(item, enabled, cx) {
    if (this.eccSaving || (item.unavailable && enabled) || !item.providers.includes(this.eccProvider)) return;
    chooseEccItem(this.eccDraft, this.eccProvider, item, enabled); this.eccSaved = false; cx.notify();
  },
  showEccSource(item, cx) {
    this.eccShowSource = !this.eccShowSource;
    if (!this.eccShowSource || this.eccDetailText !== null) { cx.notify(); return; }
    const source = this.eccCatalogInput, request = this.eccDetailRequest = (this.eccDetailRequest || 0) + 1;
    this.eccDetailLoading = true; this.eccDetailError = null; cx.notify();
    cx.spawn(async cx => {
      try {
        const result = await exec('node', [eccRuntimePath(), 'detail', source, item.id], { timeout: 60000 });
        if (result.code !== 0) throw new Error(result.stderr?.trim() || 'Could not read this component.');
        if (this.eccClosed || request !== this.eccDetailRequest || this.eccSelected !== item.id || source !== this.eccCatalogInput) return;
        this.eccDetailText = JSON.parse(result.stdout).text;
      } catch (error) { if (!this.eccClosed && request === this.eccDetailRequest) this.eccDetailError = error.message; }
      finally { if (!this.eccClosed && request === this.eccDetailRequest) { this.eccDetailLoading = false; cx.notify(); } }
    });
  },
  saveEcc(cx) {
    if (this.eccSaving || this.eccLoading || !this.eccDraft) return;
    let config;
    try { config = parseEcc(JSON.stringify({ ...this.eccDraft, source: this.eccSource })); }
    catch (error) { this.eccError = error.message; cx.notify(); return; }
    if (config.enabled && (!this.eccCatalog || this.eccCatalogInput !== config.source)) {
      this.eccError = 'Load the current source before saving your selections.'; cx.notify(); return;
    }
    this.eccSaving = true; this.eccError = null; this.eccSaved = false; cx.notify();
    const draftPath = `${appHome()}/data/devkits/ecc-drafts/${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
    let draftWritten = false;
    cx.spawn(async cx => {
      try {
        if (config.enabled) {
          await mkdir(`${appHome()}/data/devkits/ecc-drafts`, { recursive: true });
          await writeTextFile(draftPath, JSON.stringify(config), null);
          draftWritten = true;
          const result = await exec('node', [eccRuntimePath(), 'validate-file', draftPath], { timeout: 240000 });
          if (result.code !== 0) throw new Error(result.stderr?.trim() || 'Could not prepare the selected ECC components.');
        }
        const text = `${JSON.stringify(config, null, 2)}\n`;
        await writeTextFile(eccPath(), text, this.eccOriginal);
        this.eccOriginal = text; this.eccDraft = config; this.eccSaved = true;
      } catch (error) { this.eccError = error.message; }
      finally { if (draftWritten) { try { await unlink(draftPath); } catch {} } this.eccSaving = false; if (!this.eccClosed) cx.notify(); }
    });
  },
  eccOverview(t) {
    const catalog = this.eccCatalog;
    return v_flex().id('ecc-overview').flex_1().min_h(0).overflow_y_scroll().gap(12)
      .child(v_flex().p(12).gap(6).border(1).border_color(t.border)
        .child(div().text_size(14).child('Understand what each part of ECC does'))
        .child(div().text_size(12).text_color(t.muted).child('Rules and contexts guide behavior. Skills supply methods. Agents, commands and workflows organize work. Hooks react to events; MCP connects tools.'))
        .child(div().text_size(12).text_color(t.muted).child('Choose components in the Claude Code or Codex tab. Saved selections apply to all local accounts, Profiles and Tasks for that provider. The upstream source stays unchanged.')))
      .children(eccGroups.map(group => {
        const items = catalog?.items.filter(item => item.group === group.id) || [];
        return v_flex().gap(6).p(12).border(1).border_color(t.border)
          .child(h_flex().items_center().justify_between().gap(8)
            .child(div().text_size(13).child(`${group.label}${catalog ? ` · ${items.length}` : ''}`))
            .child(Button(`ecc-open-${group.id}`, t, { variant: 'secondary' }).h(28).disabled(!catalog)
              .on_click((_event, cx) => this.selectEccSection(group.providers.includes(this.eccProvider) ? this.eccProvider : group.providers[0], group.id, cx)).child('Browse components')))
          .child(div().text_size(12).text_color(t.muted).child(group.description))
          .child(div().text_size(12).text_color(t.muted).child(group.example))
          .child(div().text_size(11).text_color(t.dim).child(group.providers.map(eccProviderName).join(' · ')));
      }))
      .child(div().text_size(12).text_color(t.muted).child(catalog ? `Bundled ECC ${catalog.version}` : 'Bundled ECC'))
      .child(div().text_size(12).text_color(t.muted).child('Managed by Devkits. Loading the catalog reads the bundled files without running their code.'));
  },
  eccComponentDetails(item, t) {
    const group = eccGroups.find(group => group.id === item.group), enabled = eccItemEnabled(this.eccDraft, this.eccProvider, item);
    const missing = (item.requires || []).map(id => this.eccCatalog.items.find(entry => entry.id === id)).filter(entry => entry && !eccItemEnabled(this.eccDraft, this.eccProvider, entry));
    return v_flex().gap(10)
      .child(h_flex().items_center().justify_between().gap(8)
        .child(div().flex_1().min_w(0).text_size(15).child(item.title || item.name))
        .child(Switch('ecc-item-enabled', enabled, t).disabled(Boolean(this.eccSaving || (item.unavailable && !enabled))).accessibility_label(`Use ${item.name}`)
          .on_change((checked, cx) => this.changeEccItem(item, checked, cx))))
      .child(div().text_size(12).text_color(t.muted).child(group.description))
      .child(div().text_size(13).child(item.description || item.name))
      .child(div().text_size(11).text_color(t.muted).child(`Available in: ${item.providers.map(eccProviderName).join(' · ')}`))
      .when(Boolean(item.model), el => el.child(div().text_size(12).text_color(t.muted).child(`Role model: ${item.model}`)))
      .when(Boolean(item.tools), el => el.child(div().text_size(12).text_color(t.muted).child(`Role tools: ${item.tools}`)))
      .when(Boolean(item.event), el => el.child(div().text_size(12).text_color(t.muted).child(`Trigger: ${item.event}${item.matcher ? ` · ${item.matcher}` : ''}`)))
      .when(Boolean(item.profiles), el => el.child(div().text_size(12).text_color(t.muted).child(`Claude hook modes: ${item.profiles}; current: ${this.eccDraft.claudeHooks}. This check runs only in its listed modes.`)))
      .when(missing.length > 0, el => el.child(div().text_size(12).text_color(t.ansi3).child(`Related parent actions are off: ${missing.map(entry => entry.name).join(', ')}`)))
      .when(Boolean(item.requirements?.length), el => el.child(div().text_size(12).text_color(t.muted).child(`Required setup: ${item.requirements.join(', ')}`)))
      .when(Boolean(item.unavailable), el => el.child(div().text_size(12).text_color(t.ansi3).child(item.unavailable)))
      .when(Boolean(item.modules?.length), el => el.child(div().text_size(11).text_color(t.muted).child(`Modules: ${item.modules.join(', ')}`)))
      .child(div().text_size(11).text_color(t.dim).child(item.path))
      .child(Button('ecc-read-description', t, { variant: 'secondary' }).h(28).on_click((_event, cx) => this.showEccSource(item, cx)).child(this.eccShowSource ? 'Hide source description' : 'Read full description'))
      .when(Boolean(this.eccShowSource), el => el.child(v_flex().id('ecc-original-description').gap(8)
        .when(Boolean(this.eccDetailLoading), body => body.child(div().text_size(12).text_color(t.muted).child('Loading description…')))
        .when(Boolean(this.eccDetailError), body => body.child(div().text_size(12).text_color(t.ansi1).child(this.eccDetailError)))
        .when(this.eccDetailText !== null && !this.eccDetailLoading, body => body.child(TextView.markdown(`ecc-source-${item.id}`, eccDescriptionMarkdown(item, this.eccDetailText))))));
  },
  eccProviderPage(t) {
    const provider = this.eccProvider, catalog = this.eccCatalog, groups = eccGroups.filter(group => group.providers.includes(provider));
    const all = (catalog?.items || []).filter(item => item.group === this.eccSection && item.providers.includes(provider));
    const query = this.eccSearch.value().trim().toLowerCase();
    const items = all.filter(item => !query || [item.name, item.description, item.path, ...(item.modules || [])].join(' ').toLowerCase().includes(query));
    const page = Math.min(this.eccListPage, Math.max(0, Math.ceil(items.length / eccPageSize) - 1));
    const selected = items.find(item => item.id === this.eccSelected);
    return v_flex().h_full().flex_1().min_h(0).gap(10)
      .child(h_flex().items_center().justify_between()
        .child(h_flex().gap(8).items_center()
          .child(AgentIcon({ icon: `icons/${provider}.svg` }, t))
          .child(div().text_size(13).child(`Use ECC with ${eccProviderName(provider)}`)))
        .child(Switch('ecc-provider-enabled', this.eccDraft.providerEnabled[provider], t).disabled(Boolean(this.eccSaving))
          .on_change((checked, cx) => { this.eccDraft.providerEnabled[provider] = checked; this.eccSaved = false; cx.notify(); })))
      .when(!this.eccDraft.providerEnabled[provider], el => el.child(div().text_size(12).text_color(t.muted).child('Off for this provider. Your component selections are retained.')))
      .child(div().text_size(12).text_color(t.muted).child(`${eccProviderName(provider)} global components · selected ${all.filter(item => eccItemEnabled(this.eccDraft, provider, item)).length} / ${all.length}`))
      .child(h_flex().flex_none().flex_wrap().gap(4).children(groups.map(group =>
        Button(`ecc-category-${group.id}`, t, { variant: 'ghost' }).h(30).gap(6)
          .bg(this.eccSection === group.id ? t.selected : t.popover)
          .accessibility_label(group.label)
          .on_click((_event, cx) => this.selectEccSection(provider, group.id, cx))
          .child(glyph(eccCategoryIcons[group.id])).child(group.label.split(' · ')[0]))))
      .when(this.eccSection === 'hooks' && provider === 'claude', el => el.child(Select('ecc-hook-profile', this.eccSelect, this.eccDraft.claudeHooks,
        [{ key: 'off', label: 'Hooks off' }, { key: 'minimal', label: 'Minimal · essential actions' }, { key: 'standard', label: 'Standard · normal checks' }, { key: 'strict', label: 'Strict · includes stricter checks' }].map(item => ({ ...item, color: t.foreground })),
        'Hook mode', (value, cx) => { if (!this.eccSaving) { this.eccDraft.claudeHooks = value; this.eccSaved = false; } cx.notify(); }, t, { fullWidth: true, boxed: true })))
      .when(this.eccSection === 'hooks' && provider === 'codex', el => el.child(div().text_size(12).text_color(t.muted).child('This source provides only SessionStart for Codex. Codex owns the native hook trust decision.')))
      .when(this.eccSection === 'contexts', el => el.child(div().text_size(12).text_color(t.muted).child('Select one working mode, or leave all modes off.')))
      .child(h_flex().gap(8).items_center().child(Input.new(this.eccSearch, t).h(30).px(8).text_size(12).flex_1().min_w(0).border(1).border_color(t.input).accessibility_label('Search ECC components'))
        .when(this.eccSection !== 'contexts', el => el.child(Button('ecc-group-enable', t, { variant: 'secondary' }).h(30).disabled(Boolean(this.eccSaving || !catalog))
          .on_click((_event, cx) => { for (const item of items.filter(item => !item.unavailable)) chooseEccItem(this.eccDraft, provider, item, true); this.eccSaved = false; cx.notify(); }).child(query ? 'Use search results' : 'Use all')))
        .child(Button('ecc-group-disable', t, { variant: 'secondary' }).h(30).disabled(Boolean(this.eccSaving || !catalog))
          .on_click((_event, cx) => { for (const item of items) chooseEccItem(this.eccDraft, provider, item, false); this.eccSaved = false; cx.notify(); }).child(query ? 'Turn off search results' : 'Turn off all')))
      .child(h_flex().flex_1().min_h(0).items_stretch().gap(12)
        .child(v_flex().w(224).h_full().min_h(0).flex_none().gap(8)
          .child(v_flex().id(`ecc-component-list-${provider}-${this.eccSection}-${page}-${query}`).flex_1().min_h(0).overflow_y_scroll().border(1).border_color(t.border)
            .children(items.slice(page * eccPageSize, (page + 1) * eccPageSize).map(item => Button(`ecc-component-${item.id}`, t, { variant: 'ghost' }).h_auto().min_h(48).w_full().px(10).py(8).justify_start()
              .bg(item.id === this.eccSelected ? t.selected : t.popover).on_click((_event, cx) => this.selectEccItem(item, cx))
              .child(v_flex().min_w(0).gap(3).child(div().text_size(12).child(item.pack ? `${item.pack} / ${item.title || item.name}` : item.title || item.name))
                .child(div().text_size(11).text_color(t.muted).child(item.unavailable ? 'Setup required' : eccItemEnabled(this.eccDraft, provider, item) ? 'Selected' : 'Off'))))))
          .child(h_flex().justify_between().items_center().child(Button('ecc-items-prev', t, { variant: 'ghost' }).h(24).disabled(page === 0).on_click((_event, cx) => { this.eccListPage = page - 1; cx.notify(); }).child('Previous'))
            .child(div().text_size(11).text_color(t.muted).child(`${items.length ? page + 1 : 0} / ${Math.ceil(items.length / eccPageSize)}`))
            .child(Button('ecc-items-next', t, { variant: 'ghost' }).h(24).disabled((page + 1) * eccPageSize >= items.length).on_click((_event, cx) => { this.eccListPage = page + 1; cx.notify(); }).child('Next'))))
        .child(v_flex().flex_1().min_w(0).h_full().min_h(0).id(`ecc-component-details-${provider}-${selected?.id || 'empty'}`).overflow_y_scroll().gap(10)
          .when(Boolean(selected), el => el.child(this.eccComponentDetails(selected, t)))
          .when(!selected, el => el.child(div().text_size(12).text_color(t.muted).child(items.length ? 'Select a component to read its purpose and change its selection.' : 'No matching components.')))));
  },
  eccNavigation(t) {
    return v_flex().pl(16).gap(2).children([{ id: 'overview', label: 'Overview' }, { id: 'claude', label: 'Claude Code' }, { id: 'codex', label: 'Codex' }].map(tab =>
          Button(`ecc-page-${tab.id}`, t, { variant: 'ghost' }).h(30).w_full().justify_start().gap(8).px(8).bg(this.eccTab === tab.id ? t.selected : t.popover)
            .on_click((_event, cx) => { if (tab.id === 'overview') { this.eccTab = 'overview'; cx.notify(); } else this.selectEccSection(tab.id, eccGroups.some(group => group.id === this.eccSection && group.providers.includes(tab.id)) ? this.eccSection : 'skills', cx); })
            .child(tab.id === 'overview' ? glyph('book-open', 16) : AgentIcon({ icon: `icons/${tab.id}.svg` }, t))
            .child(tab.label)));
  },
  eccPage(t) {
    const busy = Boolean(this.eccLoading || this.eccSaving), draft = this.eccDraft;
    return v_flex().h_full().flex_1().min_h(0).gap(10)
      .child(h_flex().justify_between().items_center().child(DialogTitle().child('Everything Claude Code'))
        .when(Boolean(draft), el => el.child(h_flex().gap(8).items_center().child(div().text_size(12).child('Enable ECC'))
          .child(Switch('ecc-enabled', draft.enabled, t).disabled(busy).on_change((checked, cx) => { draft.enabled = checked; this.eccSaved = false; cx.notify(); })))))
      .child(DialogDescription(t).flex_none().child('Explore the architecture, then choose what Claude Code and Codex use. Settings are global and apply to new sessions after saving.'))
      .when(this.eccLoading, el => el.child(div().text_color(t.muted).child('Loading ECC settings…')))
      .when(Boolean(draft), el => el.child(v_flex().flex_1().min_h(0).gap(10)
        .when(!draft.enabled, body => body.child(div().text_size(12).text_color(t.muted).child('ECC is off. You can prepare selections now; enable ECC and save to apply them.')))
        .when(Boolean(this.eccCatalogLoading), body => body.child(div().text_size(12).text_color(t.muted).child('Loading the component catalog…')))
        .when(Boolean(this.eccCatalogError), body => body.child(div().text_size(12).text_color(t.ansi1).child(this.eccCatalogError)))
        .when(!this.eccCatalogLoading && !this.eccCatalog, body => body.child(Button('ecc-reload-source', t, { variant: 'secondary' }).disabled(busy).on_click((_event, cx) => this.loadEccCatalog(cx)).child('Load source')))
        .when(this.eccTab === 'overview', body => body.child(this.eccOverview(t)))
        .when(this.eccTab !== 'overview', body => body.child(this.eccProviderPage(t)))))
      .when(Boolean(this.eccError), el => el.child(div().text_size(12).text_color(t.ansi1).child(this.eccError)))
      .child(DialogFooter().flex_none().child(div().flex_1().text_size(12).text_color(t.muted).child(this.eccSaved ? 'Saved. Applies to new sessions.' : this.eccSaving ? 'Preparing selected components and saving…' : 'Selection switches change the draft. Save to apply.'))
        .child(Button('ecc-discard', t, { variant: 'secondary' }).disabled(busy).on_click((_event, cx) => this.initEcc(cx)).child('Discard changes'))
        .child(Button('ecc-save', t).disabled(busy || !draft || Boolean(draft?.enabled && (!this.eccCatalog || this.eccCatalogLoading)))
          .on_click((_event, cx) => this.saveEcc(cx)).child(this.eccSaving ? 'Saving…' : 'Save changes')));
  },
};
