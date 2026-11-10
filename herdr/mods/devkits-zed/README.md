# Devkits Zed

The Devkits workspace appearance with its shell responsibilities only:
project/thread sidebar, native program picker, terminal panes and native Agent
status, Files/Changes, central previews and editor tabs, splitters, project layout
memory and the bottom dock controls. The original geometry, themes, components
and SVG icons remain in use. The top gear opens native Herdr settings.

There is no Agent Settings, account preparation, Profiles, Auto account selection,
Rules/MCP injection, Tasks, Calendar, Usage, SYSTEM, Asana/MantisBT, Simulator,
application runner, transcript archive, GitHub account manager or data reset.
These belong in future extensions. Starting a thread uses knownAgents and native
space.new/tab.new with the selected program's command unchanged.

Install into a new destination:

```sh
node herdr/install-zed.js
```

The installer adds the mod, layout, scoped thread/file shortcuts and missing shared
visual assets. It does not require companion service mods or switch the current
layout. Existing settings, credentials and data remain untouched. Workspace folder
and file preferences currently use the same UI preference keys as Devkits; per-project
panel geometry is owned by devkits-zed. No provider policy/state is read or written.

Read the root design.md and herdr/DEVELOPMENT.md for the original UI workflow.
Canonical components live in ../devkits/components and are copied through COPIES;
SVG icons remain centralized in ../devkits/assets/icons. No original Devkits mod
implementation needs to be mounted. Extension APIs remain a later step.
