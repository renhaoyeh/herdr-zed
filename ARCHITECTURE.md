# herdr-zed Architecture

Status: **phases 1–4 done** (shell and providers ported with history, contracts wired, installer and vendor/). See Known gaps.
Mod names below (`herdr-zed`, `herdr-zed-*`) are working names pending the naming decision in
[Open questions](#open-questions).

herdr-zed is the Zed-style Herdr shell currently living at `herdr/mods/devkits-zed` in the devkits repository,
rebuilt as an independent repository together with the provider mods it can host. Existing code
(Git, Files, previews, threads, project layout memory, conversation history) is moved with its history,
not rewritten. This repository has one code path: there is no compatibility branch for the original
Devkits layout or its mods.

## 1. Layers

| Layer | Mods (working names) | Owns | May depend on |
| --- | --- | --- | --- |
| **Shell** | `herdr-zed` | Projects/workspace, threads and sidebar history, Files, Git (changes, history, graph, repository commit author), central previews and editor tabs, project layout memory, panes, focus, Settings preferences, standalone launcher and Extensions management dialogs, extension registry/catalog, launch-event intake | Herdr native API and shared components only |
| **Agent Runtime** | `herdr-zed-agents` (Agents + Usage merged) | Accounts and sign-in, Profiles, Auto selection, Rules/Guide, Shared MCP, launch preparation, quota readers, usage details/statistics, Claude status-line recorder | Shell contracts |
| **Work** | `herdr-zed-tasks`, `herdr-zed-calendar` | Tasks: records, policies, drafts, progress/evidence, board, execution preparation, Tasks MCP. Calendar: events and views, independent mod, reads only the Tasks read model | Shell contracts; Agent Runtime public client (Tasks only); Calendar → Tasks read model |
| **Integrations** | `herdr-zed-asana`, `herdr-zed-mantisbt`, `herdr-zed-github` | Asana/MantisBT: source browsers, connections, REST/API layers, read-only historical task reader; deliver selections to an importer. GitHub: gh CLI account discovery, per-repository account choice, remembered account authors, credential configuration for the shell's Git commands | Shell contracts; the `importer` contract (never Tasks code) |
| **Tools** | `herdr-zed-system`, `herdr-zed-simulator` (+ `herdr-zed-sim-frames` asset package) | SYSTEM sampler/widgets/details; iOS Simulator panel, dock and Xcode Storage. Pure UI extensions | Shell contracts only |

Rules:

- Dependencies point only toward the Shell: a mod may use the contracts of the Shell and of the layers
  listed in its own "May depend on" cell, nothing else. The Shell imports no provider code and contains no
  provider-specific branches (no `if (mod === 'herdr-zed-asana')`).
- "Depend on" never means a JavaScript import across mods (Herdr forbids it). It means: a typed manifest
  declaration, a shared-state message documented in §3, or a public client component copied through
  `COPIES` (§6).
- Every provider is optional. The shell with zero extensions is a complete product: knownAgents threads,
  Files, Git, previews, history.
- Tools never depend on Work or Agent Runtime. Integrations never depend on Agent Runtime.

## 2. Extension contracts

All declarations live in each mod's `extension.json`, `version: 1`. Every package is in this repository,
so the manifest has no cross-version compatibility: when the schema changes, the parser, all manifests and
the tests change in the same commit. Unknown keys inside `provides`, surfaces and services are rejected; unknown top-level keys are currently ignored.

### 2.1 UI extension (existing v1, kept as is)

```jsonc
{
  "version": 1,
  "dataReset": { "helper": "reset-provider.js" }, // optional finite lifecycle helper, §5.1
  "id": "system",                 // extension ID, [a-z][a-z0-9-]*
  "title": "System Monitor",
  "dependencies": ["…"],          // sibling packages installed with it (not registered)
  "requires": ["tasks"],          // NEW: extension IDs that must be registered and enabled
  "services": [{ "view": "service" }],
  "surfaces": [{ "id": "widgets", "location": "sidebar.bottom|status.right|dock.right",
                 "view": "widgets", "title": "…", "icon": "…" }],
  "actions":  [{ "id": "open", "title": "…", "icon": "…", "iconColor": "#RRGGBB",
                 "location": "status.right|git.actions",
                 "popup": { "view": "details", "width": 1000, "height": 700, "modal": false, "placement": "center|workspace" } }],
  "provides": { … },               // NEW: provider contracts, §2.2
  "settings": { "view": "settings", "title": "Agents", "pages": [{ "id": "accounts", "title": "Accounts" }] },  // §2.1
  "platforms": ["macos", "windows", "linux"]   // optional, §2.1
}
```

`popup` may also declare `"placement": "center" | "workspace"` (default `center`), see below.

- Discovery reads declarations only; it never mounts views, initializes provider APIs or reads credentials.
- `services` mount in the shell's `status-separator` row while the extension is enabled.
- `surfaces` mount as native blocks at fixed locations; visibility is persisted per surface. A `status.right` surface
  mounts in the status row before the shell's `status-tools` block (its icons, dock toggles, Changes and Files), so it
  sits left of the action icons; `status-tools` is resized to its content by the shell. A `sidebar.bottom` surface
  mounts above the shell's `sidebar-history` block, which is always the last row of the sidebar.
- `actions` open a popup with the originating project captured at click time. `status.right` places an icon-only
  status-bar button (the title is its tooltip and accessible label, `iconColor` is kept); every active action is shown
  directly. `git.actions` (new) places an item in the
  shell's Git actions menu, with the selected repository (`{ machine, folder }`) as context.
- `requires`: the Extensions manager shows a package as *unavailable* while a required extension is missing,
  failed or disabled; disabling a required extension shows which dependents become unavailable. Calendar
  declares `requires: ["tasks"]`; Asana and MantisBT do **not** require Tasks (import is optional, §2.2.3).
- `settings` (optional, `{ view, title, pages? }`, these keys only): the package's page in the shell's Settings dialog. The
  shell opens `view` embedded in its configuration dialog, with `{ view, embedded: true, page, context }` (the current project,
  or null; `page` is the sub-page ID, or null for an extension without sub-pages); `title` is its configuration title. `pages` (optional, 1–12
  entries, each exactly `{ id, title }`, ids `[a-z][a-z0-9-]*` and unique within the package, titles non-blank) are
  tabs inside the extension's configuration page, in declaration order; the first is selected when opening the extension.
  Unknown keys in `settings` or a page are rejected. Its Configure entry in the Extensions overview is available only
  while the package is enabled, error-free and available. Settings opens from the header gear, from the Extensions
  page, or from the provider's own panel with the shell command `herdr-zed.settings:<extension id>` or
  `herdr-zed.settings:<extension id>:<page id>`. The provider never gets a reply and never renders the nav or the frame.
- The launcher provider's configuration (Agents) is a standalone workflow dialog, reached from thread/project ⋯ menus; it is
  excluded from the optional Extensions manager and has no enable switch. This follows `provides.launcher`, not a mod name.
  The Extensions overview and tool configuration are also independent dialogs without the main preferences nav. The shell
  replaces the current management dialog on navigation, keeping one modal open at a time.
- Agents has its thread/project menu entry; Extensions and Settings have independent main-header buttons. The Settings nav contains preferences only.
  Repository commit identity opens from Changes into the shell's contextual author editor, using the selected repository
  and machine captured at open time; it is not a general preference.
- `platforms` (optional, non-empty, unique subset of `macos`, `windows`, `linux`; absent means every platform): compared
  with `window().platform`. A package for another platform contributes nothing (no actions, surfaces, services,
  settings or provides), is never active, and the Extensions page shows "Not available on this platform" with no
  switch.
- `actions[].popup.placement` (optional, `"center"` by default or `"workspace"`; any other value is rejected). `workspace`
  opens the panel over the work area through `openWorkspacePanel` (components/workspace-overlay.js, §3.7): a
  `kind: 'window'` named `herdr-zed.workspace-panel`, `frame: 'none'`, at the published work-area rectangle and sized to it
  (x = sidebar width plus its layout divider, y = 32, width = the work column, height = window minus 32 (header) and 32 (status bar)). A click
  beside it does not close it: Esc does, a project switch or opening Settings closes it, and opening another workspace panel
  replaces it. The manifest `width` and `height` are not used for the window; they are the size of the centered fallback
  dialog, which opens while the work area is not published yet (`null`). Providers that open workspace panels themselves
  (Tasks board, Calendar, SYSTEM details) use the same function, and their roots are wrapped by `workspacePanel`, so every
  workspace panel has one placement and behaviour. The shell measures the work column (`herdr-zed.work-width`) and the
  sidebar's flexible body (`herdr-zed.sidebar-height`) with `on_size_change`; `windowHeightFromSidebar` adds the fixed brand
  and history rows back to get the window height. Herdr's `window()` reports no size.
- Surfaces: `sidebar.bottom` surfaces mount above the history row and start hidden; `dock.right` surfaces start hidden;
  `status.right` surfaces start visible. Manage extensions offers a switch per active surface: "Show in sidebar", "Show
  in status bar", "Show in right dock".

### 2.2 Provider contracts (new, typed, closed set)

`provides` accepts only the four keys below. Each has a fixed schema validated by the shell's
`extension-model.js`; anything else is an invalid manifest.

#### 2.2.1 `launcher` — at most one in the catalog

```jsonc
"provides": {
  "launcher": {
    "picker": { "view": "launcher", "width": 280 }   // popup anchored at the + button; exactly these keys
  }
}
```

The launcher's settings page is not a launcher key: it is the manifest `settings` declaration (§2.1), e.g.
`"settings": { "view": "manage-launchers", "title": "Agents" }`. Any other key under `launcher` is invalid.

- If more than one enabled package declares a launcher, the catalog records an error for each and **none**
  is used (no silent priority). The Extensions dialog shows the conflict.
- With no usable launcher, the shell uses its native picker (`native-launcher.js`: `knownAgents`, argv
  unchanged). This is also the path while the launcher's service is not mounted.
- The provider owns account preparation completely: Profiles, Auto, Rules/MCP injection, environment and
  credentials. The shell never sees an account object, only the final argv.
- Event format and lifecycle: §3.1.

#### 2.2.2 `threadDecorator`

```jsonc
"provides": { "threadDecorator": { "fields": ["badge", "subtitle", "tone"] } }
```

Data-only: the shell renders a fixed, small set of fields on thread rows and the thread title bar; the
provider never renders inside thread rows. Agents uses it for the account/profile label and quota tone;
Tasks for the linked task state. Message format: §3.3. Several decorators may coexist; each field appears
once per provider in catalog order.

#### 2.2.3 `importer`

```jsonc
"provides": { "importer": { "accepts": ["task-snapshot"], "view": "import-draft" } }
```

The receiving end of task import (Tasks declares it). Integrations look up an enabled importer in the
public catalog; with none, they hide "Import into …" (current standalone behavior). The importer reuses
the existing `source-channel.js` protocol (§3.4). The shell only publishes the catalog; it does not relay
or inspect import payloads.

#### 2.2.4 `gitCredentials` — at most one in the catalog

```jsonc
"provides": { "gitCredentials": {} }
```

Supplies per-repository credential configuration that the shell adds to the Git network commands it runs
for that repository (fetch, pull, push, push tags); local reads run without it. `herdr-zed-github` declares it. The shell knows
nothing about gh: it only reads, validates and applies the binding (§3.5). With no provider, or no binding
for a repository, Git runs with the machine's own credential configuration, unchanged.

- Uniqueness follows the launcher rule: two enabled declarations disable both and report a conflict.
- Commit author (`git config --local user.name/email`) stays in the shell. The GitHub extension may
  suggest an author from the account's public profile in its own dialog and saves it through the same
  repository-local Git config; the shell's Commit author dialog remains available without the extension.

## 3. Shell ↔ provider messages and lifecycle

Transport is Herdr shared state (`shared`/`setShared`) or the native mod command bus (`run`/`nextCommand`)
where the existing code already uses it. Never `sessionStorage` (isolated per script context) and never
retained JavaScript callbacks. All keys use the `herdr-zed.` prefix so this repo can run beside an
installed Devkits without reading or consuming Devkits' queues (e.g. `devkits.agents.navigation`).

### 3.1 Launch

```
user clicks + / invokes New Thread (New terminal opens directly from the project menu)
 └ shell: the project's editor shows the composer (task text, program, session fields); start icon / configured Enter shortcut:
 └ shell: catalog has one usable launcher?
     no  → native program → createNativeThread(knownAgent, { …target, task? })          (argv unchanged)
     yes (and every service it declares is mounted):
       launcher published this machine in 'herdr-zed.composer.<id>' → shell appends a launch intent to
              'herdr-zed.launch.intents': { id, launcher, target, choice, values, task?, expiresAt }
       not yet → openOverlay({ mod: <launcher mod>, kind: 'popup',
              props: { view: picker.view, space, folder, projectName, machine, task? } })   (flat, like the native picker)
 └ provider: user picks; provider prepares account (may take seconds, shows its own progress/errors)
 └ provider appends to shared 'herdr-zed.launch.requests':
       { id, source: '<extension id>', target, name, argv, profile, expiresAt, origin?, task? }
       and prunes expired entries while appending (the shell never writes this key)
 └ shell (polls in its own view, 100 ms) claims unexpired requests whose id is not in
   'herdr-zed.launch.handled' (ids + expiresAt, pruned at expiry), records them as handled, then validates:
       - source is the current launcher's extension id and it is enabled
       - expiresAt is a number, > now and ≤ now + 60 s
       - target = { space?, folder, projectName?, machine?, overlay? } with folder a non-empty string;
         space, if given, exists; machine matches the space's machine
       - name: non-empty string ≤ 120 chars; argv: non-empty array of strings; profile: string or null
       - task, if given: non-empty string ≤ 20 000 chars, passed as tab.new / space.new `task` (first message)
         (Herdr does not deliver `task` to a wrapped launch command, so Agents puts a Claude Code or Codex task in
          argv as the prompt argument instead and sends `task` only for other programs)
     invalid / expired → dropped, notify error once, picker left open
     valid → tab.new / space.new with argv **as given** (no terminalArgv rewrite, no quoting, no
             injection), record { profile, source } for the new tab, close target.overlay, focus main
```

- **Composer** (`composerChoices`, `launchIntent` in `extension-contract.js`): the launcher publishes
  `herdr-zed.composer.<id>` = `{ updatedAt, machines: { [machine | '']: { choices } } }`; a choice is
  `{ key, label, icon?, tint?, detail?, tone?, fields }` (`detail` ≤ 80 chars, a reading shown beside the choice such as
  its account's quota, coloured by `tone`: muted, accent, warning or error) and a field is a `select` (`{ id, label, value, options: [{ key, label, only? }] }`,
  `only` = `{ [field id]: keys }` it is offered with) or a `toggle` (`{ id, label, value: boolean }`). The shell draws
  them without knowing what they mean and drops malformed choices. It only appends intents; the launcher takes its own
  off the queue, prepares the session from `values` and emits a launch request as above, notifying its own errors.
- `id` and `profile` let the shell match the new tab when it appears (current `pending-profiles` pattern)
  and expose `{ tabId, profile, source }` in the thread read model (`herdr-zed.threads`) for decorators.
- When auto-resume reopens a conversation after a restart, the new tab's record carries `replaces: <old tab id>` (and the
  old record's profile, source and origin), so a provider moves what it linked to the old tab across. Providers may read
  the shell's resume records (`herdr-zed.thread-sessions`, `{ [tabId]: { sessionId, command, ... } }`) and never write them.
- Local-shell wrapping (`terminalArgv`) is the provider's job for provider launches; the shell applies it
  only on the native knownAgents path, as today.
- **Terminal**: a launcher's picker opens a plain terminal with the shell command `herdr-zed.new-terminal`
  (target encoded in the command name, validated with `validateLaunchTarget`); it never opens tabs itself.
- **Settings**: the shell does not open a launcher settings page (the thread ⋯ entry is removed). A launcher's settings
  page is its `settings` declaration (§2.1), shown in the Settings dialog.
- Closing or failing the picker never leaves a request behind; requests older than `expiresAt` are dropped
  by the shell on its next poll, so a crashed provider cannot start a thread later.

### 3.2 Catalog (shell → everyone)

`herdr-zed.extensions.catalog` (read-only for providers):
`{ ready, packages: [{ mod, id, title, enabled, error?, provides }], actions, errors }`.
Providers use it to find an importer or to know whether a launcher is active. They never write it.

### 3.3 Thread decorations (provider → shell)

`herdr-zed.decorations.<extension id>` = `{ updatedAt, threads: { <tabId>: { badge?, subtitle?, tone? } } }`.
`badge`/`subtitle`: strings ≤ 40 chars; `tone`: `muted|accent|warning|error`. Missing tabs are ignored;
the key is removed when the extension is disabled (shell clears it). Providers publish only on change.

### 3.4 Import (integration → importer)

- Opened by the importer itself (Tasks opens a source browser): the existing `source-channel.js`
  protocol, unchanged. Requests are removed on import or close.
- Opened standalone from the status bar: the integration finds an enabled importer in the catalog and opens
  `openOverlay({ mod: <importer mod>, kind: 'dialog', props: { view: provides.importer.view,
  kind: 'task-snapshot', source: <extension id>, context, snapshot } })`. The snapshot holds explicit domain
  fields only (no credentials, no callbacks).
- Either way the importer revalidates the snapshot and opens its draft; only confirming creates a record.

### 3.5 Git credentials (provider → shell)

`herdr-zed.git-credentials.<extension id>` =
`{ updatedAt, repositories: { "[machine, folder]": { host, login, config: [[key, value], …] } } }`

- Key: `JSON.stringify([machine || '', folder])`, the same project key the shell already uses.
- The provider builds `config` (today's `gitAuthArgs`: an inline shell-function credential helper calling
  `gh auth token --hostname H --user L`). It stays inline so it works on remote machines, where mod files
  do not exist. Tokens never enter shared state; only the helper command does.
- Before each Git command the shell validates the binding and drops it entirely (with one error
  notification) unless: `host` and `login` match the current patterns; `config` has ≤ 8 pairs; each key is
  one of `credential.https://<host>.helper`, `credential.https://<host>.username`,
  `url.https://<host>/.insteadOf` for exactly that host; values are strings without NUL or newline, and
  `insteadOf` values are `git@<host>:` or `ssh://git@<host>/`. Valid pairs become `-c key=value` in order.
- The shell never switches gh's active account and never writes credential settings to disk.
- Disabling the extension clears its key; the next Git command runs without the binding.
- The account picker opens from the `git.actions` menu entry; Save/Cancel ordering and credential
  isolation follow the current `git-author-settings.js` behavior.

### 3.6 Lifecycle

| Event | Shell behavior |
| --- | --- |
| Startup / `herdr-zed.extensions-refresh` | Read registry → parse manifests → publish catalog → mount services/surfaces |
| Enable | Mount services/surfaces; launcher becomes active if it is the only one |
| Disable | Unmount owned blocks, clear its decorations, launcher falls back to native picker; open popups and provider data are kept |
| Manifest error | Package shown as unavailable; its contributions are not mounted |
| Provider service not mounted | Launcher treated as unavailable (native picker); importer hidden |

### 3.7 Work area (shell → providers, read-only)

`herdr-zed.workspace-rect` = `{ x, y, width, height, updatedAt }`, or `null` while the work area is not measured. Logical
px: x = sidebar width plus its layout divider (0 when hidden), y = 32 (header), width = the work column, height = window height minus 32 (header)
and 32 (status bar). The shell writes it whenever the value changes (on each render and each measured size change); it
never writes it otherwise. Providers only read it.

- Providers open workspace panels with `openWorkspacePanel({ mod, props, width?, height?, modal? })`
  (components/workspace-overlay.js, copied by `COPIES`). It opens the window spec over the published rectangle (device px
  at the window zoom), or, with `null`, the centered dialog of `width`/`height` (default 0.9 × 0.86), and records the open
  id in `herdr-zed.workspace-panel.overlay` so the shell can close it. Status actions pass their ID as `props.workspaceAction`;
  `herdr-zed.workspace-panel.active` holds `{ overlay, action }` for the selected status button. Provider `close()` calls
  `releaseWorkspacePanel()`, which clears only the closing overlay's state, preserving a replacement panel's active action.
  Each panel root is wrapped by `workspacePanel(el)`:
  it stops presses (a window is otherwise dragged by them) and closes the panel on Esc that its controls did not consume.
- The shell's `popup.placement: "workspace"` actions use the same function (§2.1), so there is one placement path.

### 3.8 Status reading emptiness (provider → shell)

`herdr-zed.surface-empty.<extension id>.<surface id>` = `true` while a `status.right` surface has nothing to show; `false`
or absent (or `null`) means shown. The shell hides such a reading (`layout.hide`) so it takes no width, and shows it again
when the key clears. Hidden readings take no space in the row.

- The provider writes the key only when its value changes, from a timer or sync logic, never during render (every
  `setShared` re-renders all mods, so a write from render would loop).
- Agents exposes Usage only in the sidebar. It has no visibility toggle;
  no status Usage view, subscription or emptiness reporter is mounted.
- The shell reads the keys on each status layout sync; the status-tools view re-renders after every shared write and
  triggers that sync. Disabling the extension clears its keys.
- Only `status.right` surfaces are governed; the shell never hides a sidebar or dock surface through this key.

## 4. Mods and move order

| # | Target | Source in devkits | Notes |
| --- | --- | --- | --- |
| 2 | `mods/herdr-zed/` | `herdr/mods/devkits-zed/` | Shell. Add `provides` parsing, launch intake, decorations, `requires` |
| 2 | `components/`, `assets/icons/`, `themes/`, `layouts/herdr-zed.json` | `mods/devkits/components/`, `mods/devkits/assets/icons/`, `themes/`, `layouts/devkits-zed.json` | Only components used by moved mods |
| 2 | `test/` | `herdr/test/zed-*.test.js`, `sync-shared.test.js`, `diff*`, `files`, `git-*`, `workspace-editor`, `project-layout` tests | Plus new contract tests |
| 3a | `mods/herdr-zed-system/` | `devkits-system` | Tools |
| 3a | `mods/herdr-zed-simulator/`, `mods/herdr-zed-sim-frames/` | `devkits-simulator`, `devkits-sim-frames` | Tools; Xcode Storage stays here |
| 3b | `mods/herdr-zed-agents/` | `devkits-agents` + `devkits-usage` | One provider; declares `launcher` + `threadDecorator`; one `service` view |
| 3c | `mods/herdr-zed-tasks/` | `devkits-tasks` | Declares `importer`, `threadDecorator`; uses Agents' public client for preparation |
| 3c | `mods/herdr-zed-calendar/` | `devkits-calendar` | `requires: ["tasks"]` |
| 3d | `mods/herdr-zed-asana/`, `mods/herdr-zed-mantisbt/` | `devkits-asana`, `devkits-mantisbt` | Import via catalog importer only |
| 3d | `mods/herdr-zed-github/` | `devkits-zed/git-auth.js` and the account half of `git-author-settings.js` | Declares `gitCredentials` and a `git.actions` action. Step 2 keeps these files in the shell unchanged; 3d moves them and removes the shell's gh code in the same series |
| 4 | `install.js`, `sync-shared.js`, `COPIES`, `vendor/` | `install-zed*.js`, `sync-shared.js`, `COPIES`, `vendor/everything-claude-code` (submodule) | One installer; ECC stays a submodule |

Not moved: `mods/devkits` (old shell), `layouts/devkits.json`, `install.js` reinstall path for the old
layout, `zed-shell/` preview harness (re-created later as an isolated-home preview script if wanted).

History: run `git filter-repo` on a **fresh clone** of devkits (never on the working checkout), keep the listed
paths with `--path`, rename with `--path-rename`, then merge into this repo with
`--allow-unrelated-histories`. `git filter-repo` is not installed on this machine yet. Note that
devkits-zed files were created as copies of `mods/devkits/*` (7 commits under that path); to keep earlier
history of e.g. `diff.js`/`files.js`, the filter also keeps their original paths in `mods/devkits/` and
the old paths are removed in a follow-up commit. Each move is one commit series per step; the tree must
pass `npm test` after every step.

## 5. Data paths

Herdr home = `HERDR_APP_HOME` or `~/.config/herdr-app`.

| Data | Location | Decision |
| --- | --- | --- |
| Accounts, credentials, MCP, ECC settings/packages, usage caches, source connections, diff filters | `data/herdr-zed/` | Own; never reads or migrates Devkits data |
| Guide (global rules) | `data/herdr-zed/AGENTS.md` | Own |
| Your Rules and Skills, their off switches | `data/herdr-zed/capabilities/`, `data/herdr-zed/capabilities.json` | Own |
| Extension registry | `data/herdr-zed/extensions.json` | Own |
| Images pasted into a prompt | `data/herdr-zed/attachments/` | Own; removed by full reset |
| Preferences, history, Profiles, Tasks/Calendar, GitHub choices | `herdr-zed.*` shared keys | Own; cleared through native APIs only |
| Bundled ECC source | `mods/herdr-zed-agents/ecc-source/` | Installed dependency, refreshed by installer; retained by reset |
| Dedicated program keys / Profiles | `herdr-zed-claude-*`, `herdr-zed-codex-*`, `herdr-zed-preset-*` | Distinct from other products |
| External default CLI integrations | `herdr_zed_shared_mcp`, `herdr-zed-*` recorder/ECC files and marketplace names | Own markers and displaced MCP transport snapshots; default sign-ins/history stay external |

No code reads both old and new paths. Existing Devkits data stays untouched; accounts and
connections must be configured separately in Herdr Zed. Global native program discovery excludes
launchers referencing another product's data directory in the same Herdr home.

### 5.1 Complete data reset

Settings → Data belongs to the shell. Optional manifest `dataReset: { helper: "reset-provider.js" }`
(or `null`/absent for no extra cleanup) declares a finite Node helper inside that provider's folder.
The helper name is a plain `.js` basename, never a path. This is an explicit lifecycle interface,
not a shell import or provider-name branch. Manifest version remains 1. All installed packages
participate, including disabled ones; reset does not initialize their UI or services.

The shell invokes helpers as `node <helper> inspect <Herdr home> HERDR ZED` (read-only JSON
`{ accounts?: number }`) or `clear` with the same arguments (JSON `{}` on success; nonzero
exit on failure). Only the explicit confirmed reset calls `clear`. Agents owns official CLI
sign-out, program-entry removal and external default integration cleanup; SYSTEM owns generated
sensor binaries; Simulator owns generated frames, never Xcode or simulator device data.

The confirmation requires `HERDR ZED` and a short-lived, one-use native authorization. It replaces
Settings, checks other overlays, swaps to a service-free transient root, closes open projects and
waits for their removal. The shell coordinator stops terminals referencing its own data directory
and actual descendants, then this installation's Node helpers/descendants, verifying exit before
provider cleanup. Stops fail before sign-out; later failures disclose possible partial sign-out,
preserve remaining files and allow explicit retry. A lock prevents concurrent resets, symbolic
link deletion roots are rejected, and shared.json is never edited by helpers.

After hooks complete, remove `data/herdr-zed/`, recreate only the default registry for installed
packages, reset only Zed layout shortcuts and clear `herdr-zed.*` values through native APIs.
Restore the installed layout and close Herdr to discard module caches. No deletion replays after
reload/restart. Project files, Devkits, unrelated Herdr settings/program entries and default CLI
credentials/history remain untouched. Owned ECC plugins in external default accounts are disabled
through existing native managers; those managers retain their caches. Bundled ECC source remains
installed outside the data reset boundary.

## 6. Shared components and sync

- Canonical sources move to top-level `components/` (there is no `mods/devkits` mod here). Icons move to
  `assets/icons/` and are installed to `mods/herdr-zed/assets/icons/`; `icon.js` points there instead of
  `mods/devkits/assets/icons/`.
- `sync-shared.js` and `COPIES` are kept with the source root changed; `npm test` runs
  `sync:shared -- --check`.
- In scope (as used by moved mods): `button`, `dropdown-menu`, `checkbox`, `toggle-group`, `dialog`,
  `alert-dialog`, `icon`, `input`, `select`, `switch`, `empty`, `sidebar`, `tree`, `side-panel`,
  `session-model`, `session-shell`, `system-monitor*`, `task-source*`, `source-channel`, `task-theme`,
  `tasks-model`, `tasks`, `workspace-overlay`, `shared-mcp*`, `agent-session-windows`, `agent-process-windows`, `progress`,
  `usage`, `claude-usage-hook`, `agent-selection`, `agents`.
- New: `extension-contract.js` (launch/decoration/git-credential validators) and `contract-types.d.ts`
  (contract types). Providers copy both to validate and type-check their own messages before sending.
- Typing: JavaScript with JSDoc, no build step. `npm run typecheck` runs `tsc` against Herdr's installed
  `herdr.d.ts`/`gpui-kit.d.ts`; contract code opts in with `// @ts-check`.
- After the Agents+Usage merge, `usage.js` and `agents.js` copies inside the merged mod become internal;
  only Tasks (and the shell, not at all) keep a public-client copy. Remove unused components.

## 7. Tests

- Contract tests (phase 2): manifest parsing incl. `provides`/`requires`, launcher uniqueness, launch
  request validation (expired, wrong source, bad argv, unknown space), argv passed byte-for-byte,
  decoration field limits, catalog shape, fallback to native picker, `git.actions` placement,
  `gitCredentials` uniqueness and validation (foreign host, extra keys, newline values, bad insteadOf
  rejected; valid pairs applied in order; no binding → no extra arguments).
- Each provider gets a manifest test against the real parser.
- Tests use mocked native APIs and temporary homes; never start agents or touch real sessions/accounts.

## Open questions

1. **Data paths.** Resolved: all product data is independent under `data/herdr-zed/` and `herdr-zed.*` keys (§5). No automatic migration from Devkits.
2. **Name.** "Zed" is Zed Industries' product name and may cause confusion. The repo/mod/key prefix
   (`herdr-zed`) should be fixed before step 2, because it appears in mod names, shared keys and data paths.
3. **Launcher settings entry.** Resolved: one Settings dialog (§2.1 `settings`) opened from the header gear. The thread ⋯
   entry and the status bar Extensions icon are removed. Previously: thread title bar ⋯ menu
   (`<launcher title> settings…`).
4. **Task-originated launches.** Adopted proposal (phase 3): Tasks calls `AgentClient.launch(…, { origin })`;
   the launcher adds optional `origin: { extension, ref }` to the launch request and the shell echoes it in
   `herdr-zed.threads`. Revisit if you prefer matching by tab appearance.
5. **thread-decorator scope.** The task brief was truncated at this item; §2.2.2 is a proposal (data-only
   fields), please confirm or correct.
6. **Work layer wording.** The brief's Work line was partly garbled; this document assumes Tasks owns
   tasks and prompts, and Calendar is an independent mod that requires Tasks and reads only its read model.

## Known gaps

- Tasks "Restore conversation" has no path yet (inline error only). Pending-profile/resume code in Tasks has
  no writers and can be removed.
- Asana/MantisBT tests still evaluate Tasks modules; `import-target.js` is duplicated in both integrations.
- Pre-existing: `mcp-probe` stdio missing-command case fails on Windows (same in devkits); the hardware
  symlink and Windows live-helper tests can time out under full-suite load.
- Shell and providers are installed in the local Herdr home; UI and keyboard behavior have been exercised in an isolated
  macOS preview. Real account sign-in and task-agent launches have not been exercised.

Shared MCP connections use one Agents MCP Connections settings page and one shared configuration. Capabilities selects bundled Rules/Skills and shows MCP dependencies; missing or disabled dependencies must be managed in MCP Connections. Existing user-added servers use the validated transport and verification flow, with draft changes saved explicitly. The UI does not create arbitrary new servers.

Tasks keeps workflow stage (`todo`, `doing`, `review`, `done`) separate from run status (`starting`, `doing`, `waiting`, `done`, `fail`, `stopped`). The existing report_task wire states are unchanged: a successful `done` report stores a finished execution and a `review` board stage, while `fail` retains `doing` with an error. User status controls accept review into done. Archived background runs explicitly retain report access; ordinary archives reject further reports. Archive/restore never launches, commits or discards changes.
