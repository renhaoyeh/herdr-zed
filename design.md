# herdr-zed Design Rules

These rules extend the devkits `design.md` (Sera defaults: square corners, `theme()` tokens, Georgia dialog
titles). Where they conflict, this file wins.

## Settings

- Switches match Devkits Sera: square 28×16 tracks, 10px square knobs, an outlined off state and a solid on state.
- The main window header has independent Extensions and Settings buttons. Agents opens from the thread's ⋯ menu;
  the project ⋯ menu provides the same setup entry before the first thread exists. Settings opens from its gear
  (and `herdr-zed.settings`), with a fixed 220px nav and General/Git preferences. It has no Agents/Extensions links.
  "App settings…" opens Herdr's appearance, keyboard and terminal settings. One management dialog is open
  at a time: navigating replaces it, rather than stacking another modal.
- Management dialogs are 1040×0.86 and modal, with one shell-owned 1px outer border, a 64px title bar and an X. No Done buttons.
- Extensions manages optional tools: enable switches, display location switches and Configure links. The launcher workflow
  is excluded: Agents has its own dialog with account/launch/rules tabs and no enable or Usage display switches.
  Its tabbed header is 104px high. Global Rules is a single editable Guide with Save, without section checkboxes or a separate preview. MCP Connections manages existing built-in, recommended and user-added shared servers without a search field or arbitrary add action. Connection actions stay above the scrolling details. Capabilities selects built-in Rules/Skills and names required connections; use the MCP Connections tab to manage them; it does not configure or enable MCP servers. Launch menu has no duplicate connection dialog entry. A single checked "Show Usage" item in the thread ⋯ menu controls the Usage sidebar;
  Usage has no status-bar contribution.
  The shell identifies launcher workflows by their declared capability, without provider-specific branches.
- Tools themselves open from the main window's status bar, sidebar or dock. An extension's configuration has a back button
  to the Extensions manager, enable/display controls and contextual tabs. Its header is 96px, or 144px with tabs. The first
  declared sub-page is selected on entry. Git preferences contain all-project display filters; Commit author opens from
  the Changes Git menu as a repository-scoped 760×400 form, with its own Save and close control.
- Providers never create the management dialogs themselves. They declare `settings: { view, title }` and deep-link
  with `run('herdr-zed.settings:<extension id>')`. A page may declare sub-pages (`pages`), listed as tabs inside
  its detail page and deep-linked with `herdr-zed.settings:<extension id>:<page id>`. An embedded settings view draws no frame, close button
  or Done footer.
- Agents is the thread menu's configuration entry. Other management dialogs stay out of thread menus and the status bar.
- Optional tools' display switches name their content and position, e.g. "Show System metrics in status bar".

## Sidebar

- Top to bottom: the thread list, the sidebar surfaces (Usage via the thread menu; optional tools via Extensions), and the
  thread history row. The history row is always the last row (its own layout block `sidebar-history`).
- Sidebar surfaces start hidden the first time they mount; Manage extensions turns them on.
- The sidebar width can be dragged horizontally. Its top bar and history row stay 32px high; internal vertical
  boundaries cannot be dragged to resize the thread area.

## Status bar

- Left: context (conversation toggle, machine). Right, in order: `status.right` surfaces (live readings) →
  extension action icons (all shown, icon only, tooltip = title) → dock toggles → Changes, Files.
- Groups use spacing, with no vertical dividers inside the status bar; the status tools are sized to what is shown.
- Button hover/selection backgrounds fill the bar's height. The sidebar footer has a 4px horizontal inset.
- Hide the thread toggle when the project has no visible thread to open.
- Clicking an active extension status button closes its panel; clicking another opens that panel. Opening an already open
  extension through a command preserves its existing instance.

## Separators

- 1px `border`-colored dividers separate distinct groups: in the sidebar between the thread list, optional
  extension surfaces and the bottom history row (always the last row); in the Settings nav between
  preferences and the "App settings…" link.
- No dividers inside a group; spacing alone separates items of the same kind.
- Workspace panels start after the sidebar divider, inside the work column, and leave the layout's divider visible.

## Icons and hover

- Glyphs come from `assets/icons/` via `glyph(name, size)`; never font glyphs or emoji. One icon per meaning
  (settings = `settings`, close = `close`, more = `ellipsis`, new = `plus`, Changes = `git-compare`).
- Sizes: 14px in rows and menus, 16px in toolbars and the status bar. Icon-only buttons have a 28×28 hit
  area (24×24 in dense rows); status-bar buttons are 28px wide and fill the bar height. Always supply a tooltip + accessibility label.
- Every icon-only button is the shared `ToolbarButton` icon variant (`components/button.js`): `icon: true` for a
  28×28 toolbar target with a 16px glyph, `icon: true, row: true` for a 24×24 row target with a 14px glyph.
  Header and status-bar buttons extend this with `h_full()`. Window caption buttons keep their own full-height targets.
- Every toolbar or status-bar action is an icon button. In a menu, either every item has an icon or none.
- One hover treatment for all interactive elements: background `hover`, no border or color shift; selected
  state uses `selected`; disabled is 45% opacity and never hovers. Non-interactive rows never hover.
  Exception: filled buttons (default, destructive) dim to 90% on hover instead.
- Hover-revealed row actions (e.g. thread close) keep their space reserved so rows don't shift.
- Nested row actions use the `chrome` background on hover, appearing darker than their hovered parent row in the dark theme.
- The hover color remains distinct from the selected pane header, so actions remain visible when the pane is focused.
- A thread row spins, blocks or ticks only from what its agent reports. A plain terminal, even one running a
  foreground command, shows the terminal icon.

## Dialogs

Closing is an X in the header (or Cancel/Esc); there are no Done buttons.

| Type | Size | Modal | Closing |
| --- | --- | --- | --- |
| Confirm | 440 wide | yes | Cancel + primary; destructive variant when it ends work or deletes data |
| Form | 560 wide, height auto ≤ 0.8 | yes | Cancel + Save |
| Settings | 1040×0.86 | yes | X in the title bar; a page with unsaved edits has its own Save/Discard |
| Working panel | 0.9×0.86 | no | X at the top-right of the panel header |
| Menu / picker | 224 or 280 wide | — | Esc |
| Workspace window (extension `placement: workspace`) | the work area, under the header, above the status bar | no | Esc or its own close control; a click beside it does not close it; a project switch or Settings closes it |

A picker opened without a pointer (keyboard or the new-thread command) centres at the top of the work area.

One save semantic per page: autosave, or explicit Save — never both on one page.

## Terms

- **thread**: one item in the sidebar / one pane title bar. **terminal**: a thread without an agent.
- **conversation**: only in history/archive ("Archive conversation", "Restore").
- **project**: a folder in the sidebar ("Open folder…" adds one).
- **Changes**: the Git panel and every entry point to uncommitted diffs.
- **Settings**: the dialog above. "Import into <importer title>" for task import.

## Visual exceptions

- Tasks and Calendar use the rounded Linear board theme (inherited from devkits).
- Switches use a pill track and knob (accent when on) so their state reads at a glance.
- Asana and MantisBT browsers imitate their products' look (fixed palettes and fonts), by decision. Their
  Settings pages use Sera.


## Task board workflow

- Columns are Todo → In progress → For review → Done. An agent's successful task report moves work to For review; only the user accepts it into Done. Feedback or a new reported attempt returns it to In progress. A CLI turn ending never completes a task.
- Waiting, failed attempts, starting and stopped agents are execution information on the card, not extra columns or a separate Action Required filter. Git commits and pull requests do not determine board completion or trigger repository operations.
- Archive is independent of stage. Any card can be archived and restored with its stage preserved. Active agents require an explicit choice to keep running in the background or stop before archiving. Failed stop confirmation leaves the card visible. Background archived runs still receive progress reports.

Closing or archiving the final thread keeps its project Space open with an empty mod tab, hidden from the thread list. No replacement terminal is started. Only explicit Close project closes the Space. Closing a split pane affects only that pane.
