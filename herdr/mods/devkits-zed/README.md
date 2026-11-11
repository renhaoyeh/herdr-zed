# Devkits Zed

The Devkits workspace appearance with its shell responsibilities only:
project/thread sidebar, native program picker, terminal panes and native Agent
status, Files/Changes, central previews and editor tabs, splitters, project layout
memory and the bottom dock controls. The original geometry, themes, components
and SVG icons remain in use. The top gear opens native Herdr settings.

There is no Agent Settings, account preparation, Profiles, Auto account selection,
Rules/MCP injection, Tasks, Calendar, Usage, SYSTEM, Asana/MantisBT, Simulator,
application runner or data reset in the base shell. Sidebar conversation history and repository GitHub account/author controls are native shell features.
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
implementation needs to be mounted. The extension API supports popups and fixed sidebar, status and right-dock provider views.

## Popup extension v1

An extension mod owns extension.json with version, id, title and an actions list.
Each action declares id, title, icon, location=status.right and popup dimensions,
modal flag and view. The shell reads declarations from registered packages and
opens provider popup views only when the user clicks an entry. Enabled packages may also declare service views; these mount in the existing separator row. No provider JavaScript
is imported into the shell. Project context is captured when the popup opens;
provider bindings are scoped to that extension, machine and project folder.

Install the Asana popup extension beside the shell:

```sh
node herdr/install-zed-extension.js devkits-asana
```

This adds the package when missing and registers it in
`data/devkits-zed/extensions.json`. Existing provider code, credentials and other
registrations are preserved. In an already open workspace, run the native command
`devkits-zed.extensions-refresh` to reload declarations. The registered action then
appears in the bottom bar and opens its existing dialog. The standalone browser
has no Tasks import receiver and hides the import action.

The shell has no package-specific branches. Arbitrary position controls and generic editor views are outside this version.

Open **Extensions** using the four-block icon at the bottom-right of the status bar to view registered extensions and enable or disable them immediately. The choice persists across restarts. Disabling removes its status entry and blocks new activation; existing popup windows and provider connection data are retained. Refresh reloads the registry and declarations. This manager does not yet install or remove packages.

The same installer accepts `devkits-mantisbt`, `devkits-system` and `devkits-simulator`.
Each can be enabled or disabled independently through Extensions. MantisBT opens
its existing browser without a Tasks import receiver. SYSTEM opens its existing
details and declares `services: [{ "view": "service" }]`; the host mounts that
provider service while enabled, without a second sampler in its popup. Disabling
SYSTEM unmounts its service and stops updates to any existing details popup.
The simulator opens its original panel in a closable popup; its original dock
continues to work in Devkits.

Optional `dependencies` lists safe sibling mod names needed by a package. The
simulator declares `["devkits-sim-frames"]` for its image directory. Installation
adds missing supporting packages, preserves existing packages and runtime data,
and registers only the requested extension. Disabling never deletes these files.
The host imports no provider implementation and never discovers simulator devices
or starts streaming during manifest discovery.

## Conversation history

The sidebar offers conversation history without Tasks. Archive stores an inactive
local Claude/Codex conversation before closing its native tab; terminal threads
retain Close. Restore reuses the saved session and account command without
resending its prompt. Failed or unconfirmed starts retain the history entry.
Conversation archival currently supports local macOS/Linux sessions with one
resumable root per tab. Windows identity lookup and remote archival are not
supported. Launch commands with positional startup prompts or literal credential
environment values are rejected without closing the thread.

## Extension surfaces and repository accounts

Extensions may declare fixed sidebar-bottom, status-right and right-dock views.
Use Extensions to control their visibility. SYSTEM contributes sidebar widgets
and inline status readings backed by its existing service. Simulator contributes
its original dock panel as well as its popup. Xcode Storage is owned by Simulator
and opens from its device menu; scanning and cleanup do not require Devkits.

The Git actions menu offers GitHub account… for the selected repository and
machine. Review the commit author and Save to apply repository-local author
settings and the account choice. Cancel retains the prior choice. GitHub accounts
come from the machine's existing GitHub CLI sign-ins.
