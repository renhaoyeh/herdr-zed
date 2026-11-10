# Devkits Zed

Read ../../../design.md and ../../DEVELOPMENT.md before UI or interaction changes.
Use the existing Devkits UI design and validation process, canonical components
in ../devkits/components, npm run sync:shared and the centralized SVG icons.

Preserve the original sidebar/header/editor/right dock/bottom geometry. This mod
owns only native workspace UI: projects, threads, installed-program selection,
Agent status display, files, previews, Git changes, pane layout and focus.

Do not add Devkits account settings, Tasks, Calendar, Usage, SYSTEM, source
browsers, Simulator, runner, transcript archiving, data reset or policy injection
to this shell. Functional additions must use explicit extension interfaces. The initial contract
allows declared popup entries in the status bar; provider UI and credentials stay
in the provider mod. Keep location controls and docking out of this first version.
Use Herdr knownAgents and native tab/space commands for thread creation.

Check source and installed mods, then inspect the affected running states. Never
launch agents or modify real project/session/account data merely to verify UI.
Do not update or switch the user's original Devkits layout for a shell preview.
