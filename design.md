# herdr-zed Design Rules

These rules extend the devkits `design.md` (Sera defaults: square corners, `theme()` tokens, Georgia dialog
titles). Where they conflict, this file wins.

## Settings

- There is one Settings dialog, opened from the header gear (and `herdr-zed.settings`). Layout: 220px nav on
  the left, the page on the right under a 32px title bar with an X, 1040×0.86, modal. No Done buttons anywhere.
- Nav sections: **Workspace** (General, Git, Manage extensions) and **Extensions** (one page per enabled extension
  that declares `settings`). "Herdr settings…" at the bottom opens Herdr's native settings.
- Extensions never open their own settings dialogs. They declare `settings: { view, title }` and deep-link
  with `run('herdr-zed.settings:<extension id>')`. A page may declare sub-pages (`pages`), listed indented under
  its entry and deep-linked with `herdr-zed.settings:<extension id>:<page id>`. An embedded settings view draws no frame, close button
  or Done footer.
- No settings entries in thread menus or the status bar.

## Sidebar

- Top to bottom: the thread list, the sidebar surfaces (shown only when turned on in Manage extensions), and the
  thread history row. The history row is always the last row (its own layout block `sidebar-history`).
- Sidebar surfaces start hidden the first time they mount; Manage extensions turns them on.

## Status bar

- Left: context (conversation toggle, machine). Right, in order: `status.right` surfaces (live readings) →
  extension action icons (icon only, tooltip = title; at most 4, the rest in an overflow ⋯) → dock toggles
  → separator → Changes, Files.
- Each group after the first is divided by a 1px line (see Separators); the status tools are sized to what is shown.

## Separators

- 1px `border`-colored dividers separate distinct groups: in the status bar between context, live readings,
  extension icons, dock toggles and Changes/Files; in the sidebar between the thread list, optional
  extension surfaces and the bottom history row (always the last row); in the Settings nav between
  Workspace, Extensions and "Herdr settings…".
- No dividers inside a group; spacing alone separates items of the same kind.

## Icons and hover

- Glyphs come from `assets/icons/` via `glyph(name, size)`; never font glyphs or emoji. One icon per meaning
  (settings = `settings`, close = `close`, more = `ellipsis`, new = `plus`, Changes = `git-compare`).
- Sizes: 14px in rows and menus, 16px in toolbars and the status bar. Icon-only buttons have a 28×28 hit
  area (24×24 in dense rows) and always a tooltip + accessibility label.
- Every icon-only button is the shared `ToolbarButton` icon variant (`components/button.js`): `icon: true` for a
  28×28 toolbar target with a 16px glyph, `icon: true, row: true` for a 24×24 row target with a 14px glyph.
  Window caption buttons (minimize, maximize, close) keep their own full-height targets.
- Every toolbar or status-bar action is an icon button. In a menu, either every item has an icon or none.
- One hover treatment for all interactive elements: background `hover`, no border or color shift; selected
  state uses `selected`; disabled is 45% opacity and never hovers. Non-interactive rows never hover.
  Exception: filled buttons (default, destructive) dim to 90% on hover instead.
- Hover-revealed row actions (e.g. thread close) keep their space reserved so rows don't shift.
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
- Asana and MantisBT browsers imitate their products' look (fixed palettes and fonts), by decision. Their
  Settings pages use Sera.
