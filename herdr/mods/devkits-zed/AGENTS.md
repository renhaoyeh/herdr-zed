# Devkits Zed

Read ../../../design.md and ../../DEVELOPMENT.md before UI or interaction changes.
Use the existing Devkits UI design and validation process, canonical components
in ../devkits/components, npm run sync:shared and the centralized SVG icons.

Preserve the original sidebar/header/editor/right dock/bottom geometry. This mod
owns only native workspace UI: projects, threads, installed-program selection,
Agent status display, files, previews, Git changes, pane layout and focus.

Keep Devkits agent account settings, Tasks, Calendar, Usage, SYSTEM, source
browsers, Simulator, runner, data reset and policy injection behind explicit
extension interfaces. Native sidebar conversation history and repository GitHub
account/author controls belong to this shell. History must work without Tasks.
Extensions may declare popups and fixed sidebar, status and dock surfaces;
provider UI and credentials stay in the provider mod. Xcode Storage belongs to
Simulator. Product behavior and interaction rules live in design.md.
Use Herdr knownAgents and native tab/space commands for thread creation.

Check source and installed mods, then inspect the affected running states. Never
launch agents or modify real project/session/account data merely to verify UI.
Do not update or switch the user's original Devkits layout for a shell preview.
