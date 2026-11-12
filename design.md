# herdr-zed Design Rules

These rules extend the devkits `design.md` (Sera defaults: square corners, `theme()` tokens, Georgia dialog
titles). Where they conflict, this file wins.

## Settings

- Switches match Devkits Sera: square 28×16 tracks, 10px square knobs, an outlined off state and a solid on state.
- The main window header has independent Extensions and Settings buttons. Agents opens from the New thread panel's
  settings button beside Send; the project ⋯ menu provides the same entry. Settings opens from its gear
  (and `herdr-zed.settings`), with a fixed 220px nav and General/Git/Data preferences. It has no Agents/Extensions links.
  A switch already on screen (Files' Wrap tabs, Changes' wrap and Unified/Split) is not repeated in Settings.
  "App settings…" opens Herdr's appearance, keyboard and terminal settings. One management dialog is open
  at a time: navigating replaces it, rather than stacking another modal.
- Management dialogs are 1040×0.86 and modal, with one shell-owned 1px outer border, a 64px title bar and an X. No Done buttons.
- Extensions manages optional tools: enable switches, display location switches and Configure links. The launcher workflow
  is excluded: Agents has its own dialog with account/launch/rules tabs and no enable or Usage display switches.
  Its tabbed header is 104px high. Agents pages follow the setup flow: Accounts, Launch menu, Profiles, Capabilities, ECC, MCP Connections, Global Rules. Capabilities, ECC and Global Rules share one side navigation (Overview where present, then Claude Code and Codex). Capabilities lists built-in and your own ("Mine", from data/herdr-zed/capabilities) Rules and Skills per provider, each with a switch, and names required connections; it does not configure or enable MCP servers. MCP Connections manages existing built-in, recommended and user-added shared servers for Codex without a search field or arbitrary add action; built-in servers show no editable fields, connection actions stay above the scrolling details, and it saves its own draft. Global Rules lists, in injection order, each section a new session receives (name, source, text on demand) and ends with the editable Custom section; it has no selection controls. Each page keeps its own Save/Discard, disabled until something changed. Launch menu has no duplicate connection dialog entry. Usage has no
  visibility toggle and no status-bar contribution.
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

- Top to bottom: the thread list, the sidebar surfaces (Usage; optional tools via Extensions), and the
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

- The + button opens New thread directly. New terminal in the project menu opens a terminal without a task form.
  The New thread command opens the agent composer directly, as one editor tab per project; it never opens by itself.
  Switching tabs keeps the draft. The arrow-up icon starts the task, with a tooltip and accessible label.
  Settings → General has a checked-by-default Ctrl+Enter (Cmd+Enter on macOS) submission checkbox. When checked,
  Enter adds a line and the modified Enter starts; when unchecked, Enter starts and Shift+Enter adds a line.
  Keyboard hints and Start button text stay out of the composer.
- The composer group is vertically centered with a maximum width of 680px. Equal flexible spacers above and below
  collapse in short windows so the whole input remains scrollable. Its heading
  reads New thread on the left, with the muted project name and branch on the same row at the right. Git changes and ahead/behind counts stay in Changes.
- The task input is primary. Its bottom toolbar holds the program, every launcher field (Model, Effort, Fast), and the
  start icon. There is no extra options menu or summary. The shell uses published field order,
  without provider-specific branches. Programs open on the last agent chosen for that project; Terminal is excluded.
- Each select keeps its own menu and favorites. Starred options come first; every menu row has a star. Favorites use
  `herdr-zed.start-favorites`, `{ [launcher or '']: { [menu]: [option keys] } }`, with `program` or `<choice>:<field>`.
  Options ruled out by another field are hidden and fall back to the first available value. Model and Effort
  offer explicit values only, without Default; selections persist immediately and reopen on the last choice. Program menus show no quota readings;
  below the composer, the Usage sidebar's accounts sit side by side with the same names, meters, percentages and reset
  times, as equal cards (up to three per row, one line per window).
  In both places every account shows each window any account has; a missing one is a blank “—” line, so rows align. The selected program's account has an accent
  border; clicking another card selects its account's first program.
- The task becomes the agent's first message. A launcher that has not listed the machine yet uses Start… to open its
  picker. Without an available agent, Start task and keyboard submission are disabled; Terminal remains in the project menu.
- Starting locks the task and Start task until a new thread appears in the target project. Success closes the originating
  New thread tab and reveals the new thread when that project is active. A 30-second timeout retains the task for retry.
  The central composer has no Recent list; archived conversations remain in the existing sidebar history.
- The composer toolbar places Agents settings immediately before Send. Its header has no action buttons.
  The project menu holds only project actions (Move up/down, Close project); a thread closes from its sidebar row.
  A thread's header keeps + and maximize; a split terminal also has Close terminal, closing only that pane.

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
| Workspace window (extension `placement: workspace`) | the work area, under the header, above the status bar | no | Esc or its own close control; a click beside it does not close it; a project switch, Settings, or showing other work there (a thread, Changes, Files, New thread, a file) closes it |

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
- A task that is not Done and has no active agent can start another session with any agent (hand-off). After a first session its button reads Continue, and an editable prompt above it names the task (its gid) so the agent reads the earlier results with list_tasks and checks the project's current state before picking up what remains. Without a live thread, Restore conversation reopens its last recorded session in a new tab linked to the task.
- Waiting, failed attempts, starting and stopped agents are execution information on the card, not extra columns or a separate Action Required filter. Git commits and pull requests do not determine board completion or trigger repository operations.
- Archive is independent of stage. Any card can be archived and restored with its stage preserved. Active agents require an explicit choice to keep running in the background or stop before archiving. Failed stop confirmation leaves the card visible. Background archived runs still receive progress reports.

Closing or archiving the final thread keeps its project Space open with an empty mod tab, hidden from the thread list. No replacement terminal is started. Only explicit Close project closes the Space. Closing a split pane affects only that pane.

Account sign-in starts with browser authorization. After authentication, show the account email separately and prefill an editable display name; only Add account registers it. Naming or save errors keep the authenticated draft for retry. The 560×520 login dialog has a scrolling body for the copy-link/callback fallback.

Codex sign-in offers local browser and copy-link-to-another-computer actions. The copy-link flow never opens a local browser automatically. Pasted callbacks follow only the same-origin local /success page to complete the login server; remote redirects are never fetched.

Auto plan size uses the latest quota plan, falling back to the detected account identity plan when Usage has no plan yet. A known ×5 plan must not display ×1 merely because the Usage surface is hidden or quota readings are unavailable. Explicit manual multipliers remain authoritative.

Usage visibility controls are available only for programs supported by the quota reader. Unsupported programs, unavailable installations and derived profiles show a disabled indeterminate checkbox, and cannot join Auto. Starting a thread remains independent of Usage support.

## Data isolation and reset

- Herdr Zed stores its own accounts, MCP configuration, ECC settings/packages, source credentials,
  attachments and caches in `data/herdr-zed/`. No Devkits data or keys are read, copied or migrated.
  Dedicated program keys, Claude recorder files, Codex MCP ownership and ECC marketplace names
  use distinct Herdr Zed namespaces. External default CLI accounts remain external accounts.
- Settings → Data offers Clear data…. A separate 440px modal requires the exact text `HERDR ZED`.
  Opening, typing and Cancel do no destructive work. Confirm unmounts services/dialogs, closes
  open projects and stops owned account terminals/children and background helpers before sign-out.
  Failed stops or sign-out preserve remaining data, show incomplete state and offer explicit Retry.
- Providers declare finite cleanup helpers through `dataReset`; the shell never implements account
  cleanup. Reset removes `data/herdr-zed/`, clears only `herdr-zed.*` values through native APIs,
  resets only Zed shortcuts, and restores the installed packages' default registry and layout.
  Bundled ECC source stays installed with Agents. Remove generated simulator frames and sensor cache;
  preserve Xcode data, Devkits, project files and external default account sign-ins/history.
  Restore only unchanged owned integrations in default accounts; native plugin managers retain their
  caches, with Zed ECC integrations disabled before managed package removal.
- Close Herdr after a successful reset to discard in-memory caches. Reload/restart never replays reset.
