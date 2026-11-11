# herdr-zed Design Rules

These rules extend the devkits `design.md` (Sera defaults: square corners, `theme()` tokens, Georgia dialog
titles). Where they conflict, this file wins. Rationale and the audit behind them: [docs/ui-review.md](docs/ui-review.md).

## Settings

- There is one Settings dialog, opened from the header gear (and `herdr-zed.settings`). Layout: 220px nav on
  the left, the page on the right, 1040×0.86, modal, Done in the nav.
- Nav sections: **Workspace** (General, Git, Extensions) and **Extensions** (one page per enabled extension
  that declares `settings`). "Herdr settings…" at the bottom opens Herdr's native settings.
- Extensions never open their own settings dialogs. They declare `settings: { view, title }` and deep-link
  with `run('herdr-zed.settings:<extension id>')`. An embedded settings view draws no frame, close button
  or Done footer.
- No settings entries in thread menus or the status bar.

## Status bar

- Left: context (conversation toggle, machine). Right, in order: `status.right` surfaces (live readings) →
  extension action icons (icon only, tooltip = title; at most 4, the rest in an overflow ⋯) → dock toggles
  → separator → Changes, Files.

## Dialogs

| Type | Size | Modal | Closing |
| --- | --- | --- | --- |
| Confirm | 440 wide | yes | Cancel + primary; destructive variant when it ends work or deletes data |
| Form | 560 wide, height auto ≤ 0.8 | yes | Cancel + Save |
| Settings | 1040×0.86 | yes | Done; a page with unsaved edits has its own Save/Discard |
| Working panel | 0.9×0.86 | no | X at the top-right of the panel header |
| Menu / picker | 224 or 280 wide | — | Esc |

One save semantic per page: autosave, or explicit Save — never both on one page.

## Terms

- **thread**: one item in the sidebar / one pane title bar. **terminal**: a thread without an agent.
- **conversation**: only in history/archive ("Archive conversation", "Restore").
- **project**: a folder in the sidebar ("Open folder…" adds one).
- **Changes**: the Git panel and every entry point to uncommitted diffs.
- **Settings**: the dialog above. "Import into <importer title>" for task import.

## Visual exceptions

- Tasks and Calendar use the rounded Linear board theme (inherited from devkits).
- Asana and MantisBT browsers imitate their products' look (fixed palettes and fonts). Open decision: keep as
  an exception or move to theme tokens. Their Settings pages use Sera regardless.
