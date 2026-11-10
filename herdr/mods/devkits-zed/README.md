# Devkits Zed

The Devkits workspace appearance with its shell responsibilities only:
project/thread sidebar, native program picker, terminal panes and native Agent
status, Files/Changes, central previews and editor tabs, splitters, project layout
memory and the bottom dock controls. The original geometry, themes, components
and SVG icons remain in use. The top gear opens native Herdr settings.

There is no Agent Settings, account preparation, Profiles, Auto account selection,
Rules/MCP injection, Tasks, Calendar, Usage, SYSTEM, Asana/MantisBT, Simulator,
application runner, transcript archive, GitHub account manager or data reset.
Optional integrations belong behind explicit extension declarations. Starting a thread uses knownAgents and native
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
implementation needs to be mounted. The initial extension API supports popup entries only.

## Popup extension v1

An extension mod owns extension.json with version, id, title and an actions list.
Each action declares id, title, icon, location=status.right and popup dimensions,
modal flag and view. The shell reads declarations from registered packages and
opens the provider mod only when the user clicks its entry. No provider JavaScript
is imported into the shell. Project context is captured when the popup opens;
provider bindings are scoped to that extension, machine and project folder.

Install the Asana popup extension beside the shell:

```sh
node herdr/install-zed-extension.js devkits-asana
```

This adds the package when missing and registers it in
`data/devkits-zed/extensions.json`. Existing provider code, credentials and other
registrations are preserved. In an already open workspace, run the native command
`devkits-zed.extensions-refresh` to reload declarations. The Asana action then
appears in the bottom bar and opens its existing dialog. The standalone browser
has no Tasks import receiver and hides the import action.

The shell has no package-specific branches. Position controls, docking, generic
editor views are outside this first popup version.

Open **Extensions** using the four-block icon at the bottom-right of the status bar to view registered extensions and enable or disable them immediately. The choice persists across restarts. Disabling removes its status entry and blocks new activation; existing popup windows and provider connection data are retained. Refresh reloads the registry and declarations. This manager does not yet install or remove packages.
