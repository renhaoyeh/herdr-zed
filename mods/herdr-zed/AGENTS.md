# herdr-zed

Read the root [AGENTS.md](../../AGENTS.md) and [ARCHITECTURE.md](../../ARCHITECTURE.md) first.
UI design and interaction rules are inherited from the devkits repository until they move here.
Canonical shared components live in `../../components`; edit them there, then run
`npm run sync:shared` (the copies in `components/` are generated). Icons are in `assets/icons/`.

Preserve the original sidebar/header/editor/right dock/bottom geometry. This mod
owns only native workspace UI: projects, threads, installed-program selection,
Agent status display, files, previews, Git changes, pane layout and focus.

Keep Agent accounts, Tasks, Calendar, Usage, SYSTEM, source browsers, Simulator,
runner, provider data reset and policy injection behind explicit extension interfaces.
The shell owns Settings → Data and coordinates reset through manifest `dataReset` helpers;
provider account and cache cleanup stays inside each provider.
Native sidebar conversation history and repository GitHub account/author controls
belong to this shell. History must work without Tasks. Extensions may declare
popups and fixed sidebar, status and dock surfaces; provider UI and credentials
stay in the provider mod. Use Herdr knownAgents and native tab/space commands for
thread creation.

Shell code must not import provider code, branch on provider names, or read/write
another mod's shared-state keys. Shared-state keys use the `herdr-zed.` prefix.

Check source and installed mods, then inspect the affected running states. Never
launch agents or modify real project/session/account data merely to verify UI.
Do not change an installed Devkits layout while previewing the shell.
