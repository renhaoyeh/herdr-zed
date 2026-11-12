# herdr-zed Design Rules

These rules extend the devkits `design.md` (Sera defaults: square corners, `theme()` tokens, Georgia dialog
titles). Where they conflict, this file wins.

## Settings

- Switches match Devkits Sera: square 28×16 tracks, 10px square knobs, an outlined off state and a solid on state.
- The main window header has independent Extensions and Settings buttons. Agents opens from the New thread panel's
  header settings button; the project ⋯ menu provides the same entry. Settings opens from its gear
  (and `herdr-zed.settings`), with a fixed 220px nav and General/Git preferences. It has no Agents/Extensions links.
  "App settings…" opens Herdr's appearance, keyboard and terminal settings. One management dialog is open
  at a time: navigating replaces it, rather than stacking another modal.
- Management dialogs are 1040×0.86 and modal, with one shell-owned 1px outer border, a 64px title bar and an X. No Done buttons.
- Extensions manages optional tools: enable switches, display location switches and Configure links. The launcher workflow
  is excluded: Agents has its own dialog with account/launch/rules tabs and no enable or Usage display switches.
  Its tabbed header is 104px high. Agents pages follow the setup flow: Accounts, Launch menu, Profiles, Capabilities, ECC, MCP Connections, Global Rules. Capabilities, ECC and Global Rules share one side navigation (Overview where present, then Claude Code and Codex). Capabilities lists built-in and your own ("Mine", from data/herdr-zed/capabilities) Rules and Skills per provider, each with a switch, and names required connections; it does not configure or enable MCP servers. MCP Connections manages existing built-in, recommended and user-added shared servers for Codex without a search field or arbitrary add action; built-in servers show no editable fields, connection actions stay above the scrolling details, and it saves its own draft. Global Rules lists, in injection order, each section a new session receives (name, source, text on demand) and ends with the editable Custom section; it has no selection controls. Each page keeps its own Save/Discard, disabled until something changed. Launch menu has no duplicate connection dialog entry. The Show/Hide Usage button in the New thread panel's header controls the Usage sidebar;
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
- Agents is the New thread panel's configuration entry. Other management dialogs stay out of thread headers and the status bar.
- Optional tools' display switches name their content and position, e.g. "Show System metrics in status bar".

## Sidebar

- Top to bottom: the thread list, the sidebar surfaces (Usage via the New thread panel's header; optional tools via Extensions), and the
  thread history row. The history row is always the last row (its own layout block `sidebar-history`).
- Sidebar surfaces start hidden the first time they mount; Manage extensions turns them on.
- Project rows: the current project has a 2px accent left edge; a project without threads has a dim name and no
  placeholder row. A project row shows how many of its threads are blocked (circle-alert, `blocked`), and while folded
  also how many are done (circle-check, `done`), so what needs you is visible without opening it.
- A thread row names its branch (branch icon, muted, 11px) only when it differs from its project's, e.g. a worktree.
  Projects that share a name show their parent folder after it, here and in the project switcher.

## Header

- The project switcher is the way between projects: a search field focused on open (type to filter, Up/Down, Enter),
  then each project with its status mark (blocked, done, working, else a folder), its parent folder when the name is
  shared, its machine and its branch, and Open folder… last.
- The sidebar width can be dragged horizontally. Its top bar and history row stay 32px high; internal vertical
  boundaries cannot be dragged to resize the thread area.

## Start a thread

- Every new thread starts in the composer: only + / New thread opens it (it never shows by itself), as the editor's
  New thread tab (one per project, focused) beside files and Git views; switching tabs keeps the draft. The tab stays
  open after Start: the task and Start lock ("Starting…") until the new thread's tab appears, which clears the task;
  if none appears within 30 s, the task is given back to edit. Closing the tab cancels.
- Under the header, one row: the session controls, the program's reading, then the project's Git state on the right.
  The input box holds only the task, the shortcut hint and Start; no selects sit in it.
  - The controls are split like Zed's: the program, then one control per launcher field. The program and each select
    open their own menu (Default for the first option; options a pick rules out are hidden); a toggle is an icon
    button (Fast). Every menu row has a star: starred options are listed first in that menu, a filled star unstars.
    Program rows show the launcher's `detail` (e.g. the account's quota) coloured by `tone` as thread decorations are;
    the chosen program's reading also sits after the controls. Favorites are `herdr-zed.start-favorites`,
    `{ [launcher or '']: { [menu]: [option keys] } }`, the menu being `program` or `<choice>:<field>`.
  - Git: the branch, the uncommitted changes (a ghost button that opens Changes; "Clean" when none) and commits to
    push or behind, from `git status` at most every 5 s.
  Below the composer: RECENT, the project's last five archived threads; a row resumes that conversation.
- The thread options sit in the panel's header, as icon buttons: Show/Hide the launcher's sidebar surface (Usage), its
  settings, and Close thread for the project's current thread. A thread's own header keeps + and maximize; a split
  terminal's header also has Close terminal (close icon), which closes only that pane. Enter adds a line; Ctrl+Enter (Cmd+Enter on macOS) or Start continues. Nothing is
  sent on plain Enter. The task becomes the agent's first message; a Terminal starts without one.
- Under the task: the program (Terminal and the programs, opening on the one last chosen in that project), then the
  program's fields from the launcher extension: Model and Effort selects and a Fast toggle (zap icon, selected
  background when on). Efforts a model lacks are hidden and fall back to Default. Without a launcher, native programs
  have no fields. A launcher that has not listed the project's machine yet shows Start…, which opens its picker.

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

Account sign-in starts with browser authorization. After authentication, show the account email separately and prefill an editable display name; only Add account registers it. Naming or save errors keep the authenticated draft for retry. The 560×520 login dialog has a scrolling body for the copy-link/callback fallback.

Codex sign-in offers local browser and copy-link-to-another-computer actions. The copy-link flow never opens a local browser automatically. Pasted callbacks follow only the same-origin local /success page to complete the login server; remote redirects are never fetched.

Auto plan size uses the latest quota plan, falling back to the detected account identity plan when Usage has no plan yet. A known ×5 plan must not display ×1 merely because the Usage surface is hidden or quota readings are unavailable. Explicit manual multipliers remain authoritative.

Usage visibility controls are available only for programs supported by the quota reader. Unsupported programs, unavailable installations and derived profiles show a disabled indeterminate checkbox, and cannot join Auto. Starting a thread remains independent of Usage support.
