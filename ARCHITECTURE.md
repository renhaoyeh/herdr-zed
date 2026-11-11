# herdr-zed Architecture

Status: **phase 2 done** (shell moved with history, renamed, contract validators and type checking). Phases 3–4 pending.
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
| **Shell** | `herdr-zed` | Projects/workspace, threads and sidebar history, Files, Git (changes, history, graph, repository commit author), central previews and editor tabs, project layout memory, panes, focus, Extensions manager, extension registry/catalog, launch-event intake | Herdr native API and shared components only |
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
  "id": "system",                 // extension ID, [a-z][a-z0-9-]*
  "title": "System Monitor",
  "dependencies": ["…"],          // sibling packages installed with it (not registered)
  "requires": ["tasks"],          // NEW: extension IDs that must be registered and enabled
  "services": [{ "view": "service" }],
  "surfaces": [{ "id": "widgets", "location": "sidebar.bottom|status.right|dock.right",
                 "view": "widgets", "title": "…", "icon": "…" }],
  "actions":  [{ "id": "open", "title": "…", "icon": "…", "iconColor": "#RRGGBB",
                 "location": "status.right|git.actions",
                 "popup": { "view": "details", "width": 1000, "height": 700, "modal": false } }],
  "provides": { … }               // NEW: provider contracts, §2.2
}
```

- Discovery reads declarations only; it never mounts views, initializes provider APIs or reads credentials.
- `services` mount in the shell's `status-separator` row while the extension is enabled.
- `surfaces` mount as native blocks at fixed locations; visibility is persisted per surface.
- `actions` open a popup with the originating project captured at click time. `status.right` places a
  status-bar entry; `git.actions` (new) places an item in the shell's Git actions menu, with the selected
  repository (`{ machine, folder }`) as context.
- `requires`: the Extensions manager shows a package as *unavailable* while a required extension is missing,
  failed or disabled; disabling a required extension shows which dependents become unavailable. Calendar
  declares `requires: ["tasks"]`; Asana and MantisBT do **not** require Tasks (import is optional, §2.2.3).

### 2.2 Provider contracts (new, typed, closed set)

`provides` accepts only the four keys below. Each has a fixed schema validated by the shell's
`extension-model.js`; anything else is an invalid manifest.

#### 2.2.1 `launcher` — at most one in the catalog

```jsonc
"provides": {
  "launcher": {
    "picker":   { "view": "launcher", "width": 280 },                 // popup anchored at the + button
    "settings": { "view": "settings", "width": 1040, "height": 0.86 } // dialog
  }
}
```

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

Supplies per-repository credential configuration that the shell adds to **every** Git command it runs
for that repository (status, fetch, pull, push, history). `herdr-zed-github` declares it. The shell knows
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
user clicks + / New Thread
 └ shell: catalog has one usable launcher?
     no  → native picker → createNativeThread(knownAgent)              (argv unchanged)
     yes → openOverlay({ mod: <launcher mod>, kind: 'popup', props: {
              view: picker.view, overlay, context: { space, folder, projectName, machine } } })
 └ provider: user picks; provider prepares account (may take seconds, shows its own progress/errors)
 └ provider appends to shared 'herdr-zed.launch.requests':
       { id, source: '<extension id>', target, name, argv, profile, expiresAt }
 └ shell (polls in its own view, 100 ms) takes and removes every request, then validates:
       - source is the current launcher's extension id and it is enabled
       - expiresAt is a number, > now and ≤ now + 60 s
       - target = { space?, folder, projectName?, machine?, overlay? } with folder a non-empty string;
         space, if given, exists; machine matches the space's machine
       - name: non-empty string ≤ 120 chars; argv: non-empty array of strings; profile: string or null
     invalid / expired → dropped, notify error once, picker left open
     valid → tab.new / space.new with argv **as given** (no terminalArgv rewrite, no quoting, no
             injection), record { profile, source } for the new tab, close target.overlay, focus main
```

- `id` and `profile` let the shell match the new tab when it appears (current `pending-profiles` pattern)
  and expose `{ tabId, profile, source }` in the thread read model (`herdr-zed.threads`) for decorators.
- Local-shell wrapping (`terminalArgv`) is the provider's job for provider launches; the shell applies it
  only on the native knownAgents path, as today.
- **Settings**: the shell opens `settings.view` as a dialog with `{ context }`; there is no reply.
  Entry point location is an open question.
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

Unchanged `source-channel.js` protocol: the integration opens with a channel ID from the importer's
request, posts `binding/import/close` events, and every request is removed on import or close. The
importer revalidates the snapshot and opens its draft; only confirming the draft creates a record.

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
| Accounts, credentials, Profiles, Guide (`data/devkits/AGENTS.md`), `codex-mcp.json`, usage caches | `data/devkits/` | **Proposed:** shared with Devkits (open question) |
| Extension registry | `data/herdr-zed/extensions.json` | Own (was `data/devkits-zed/`) |
| UI preferences and layout state (shared-state keys such as `devkits.side-panel-width`, `devkits.editor-tabs`, `devkits.diff-layout`, `devkits.projects`, project layouts) | `herdr-zed.*` keys | **Proposed:** own keys, no migration (open question) |
| Conversation history, diff build filters | to be classified in the same question | |
| GitHub account per repository, remembered account authors (`devkits.git-accounts`, `devkits.git-account-authors`) | owned by `herdr-zed-github` | Key names follow the same question |
| Tasks records, Calendar events, source connections | follow the data-path decision for their provider | |

No code reads both the old and new key; whichever is chosen is the only path.

## 6. Shared components and sync

- Canonical sources move to top-level `components/` (there is no `mods/devkits` mod here). Icons move to
  `assets/icons/` and are installed to `mods/herdr-zed/assets/icons/`; `icon.js` points there instead of
  `mods/devkits/assets/icons/`.
- `sync-shared.js` and `COPIES` are kept with the source root changed; `npm test` runs
  `sync:shared -- --check`.
- In scope (as used by moved mods): `button`, `dropdown-menu`, `checkbox`, `toggle-group`, `dialog`,
  `alert-dialog`, `icon`, `input`, `select`, `switch`, `empty`, `sidebar`, `tree`, `side-panel`,
  `session-model`, `session-shell`, `system-monitor*`, `task-source*`, `source-channel`, `task-theme`,
  `tasks-model`, `tasks`, `shared-mcp*`, `agent-session-windows`, `agent-process-windows`, `progress`,
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

1. **Data paths.** Proposal: keep sharing `data/devkits/` (accounts, Guide, `codex-mcp.json`); move UI
   preferences and layout state to `herdr-zed.*` keys so this layout and the old one never affect each
   other. Also decide where conversation history, Git accounts/authors and Tasks/Calendar data live.
2. **Name.** "Zed" is Zed Industries' product name and may cause confusion. The repo/mod/key prefix
   (`herdr-zed`) should be fixed before step 2, because it appears in mod names, shared keys and data paths.
3. **Launcher settings entry.** In the thread title bar's ⋯ menu, or as the extension icon on the right
   side of the status bar?
4. **Task-originated launches.** The launch event `{ target, name, argv, profile, expiresAt }` has no task
   link. Proposal: optional `origin: { extension, ref }` echoed into the thread read model so Tasks can
   bind its run record; alternative: Tasks matches by tab appearance. Needs a decision before step 3c.
5. **thread-decorator scope.** The task brief was truncated at this item; §2.2.2 is a proposal (data-only
   fields), please confirm or correct.
6. **Work layer wording.** The brief's Work line was partly garbled; this document assumes Tasks owns
   tasks and prompts, and Calendar is an independent mod that requires Tasks and reads only its read model.
