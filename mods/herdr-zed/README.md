# herdr-zed

The Zed-style Herdr shell: project/thread sidebar, native program picker, terminal panes
and native Agent status, Files and Git changes, central previews and editor tabs,
splitters, project layout memory, the bottom dock controls, the repository GitHub
account/author controls and sidebar conversation history. The original geometry,
themes, components and SVG icons are used unchanged.

Not in the shell: Agent accounts and Profiles, Tasks, Calendar, Usage, SYSTEM,
Asana/MantisBT, Simulator, application runner and data reset. These are provider
mods that arrive in later phases; the shell reaches them only through extension
declarations (`extension.json`) and shared-state messages.

## Install

```sh
node install-zed.js
```

Run from the repository root. The installer copies this mod to `mods/herdr-zed/`
(including its icons in `assets/icons/`), the layout to `layouts/herdr-zed.json`, and
the shared themes to `themes/` when they are missing. It adds the `layout:herdr-zed`
shortcuts (`herdr-zed.new-thread`, `herdr-zed.close-file`). It refuses to overwrite
an existing `mods/herdr-zed` or layout, does not switch the current layout, and
leaves existing settings and data untouched.

## Shared state

Shell preferences and layout state use `herdr-zed.<name>` keys (for example
`herdr-zed.side-panel-width`, `herdr-zed.editor-tabs`, `herdr-zed.project-layouts`).
Shell data lives under `data/herdr-zed/`. Shared Herdr data under `data/devkits/` is
not owned by this shell.

## Components

Canonical shared components live in `components/` at the repository root. Edit them
there, then run `npm run sync:shared`; the copies under `mods/herdr-zed/components/`
are generated from them. Icons are loaded from `mods/herdr-zed/assets/icons/`.

## Extensions

An extension mod owns `extension.json` (version, id, title, actions, surfaces,
services, dependencies). The shell reads declarations from registered packages and
opens a provider's popup view only when the user activates its action. Enabled
packages may declare fixed sidebar-bottom, status-right and right-dock views, and
service views that mount in the status separator row. No provider JavaScript is
imported into the shell, and the shell has no package-specific branches.

Registry: `data/herdr-zed/extensions.json`. Extensions can be enabled or disabled
from the Extensions manager (bottom-right icon of the status bar); the choice persists.
Disabling removes the package's entries and blocks new activation without deleting
its data. Run the native command `herdr-zed.extensions-refresh` to reload declarations
in an open workspace. `install-zed-extension.js <mod-name>` registers a package that
exists under the repository's `mods/` folder; no provider packages exist in this
repository yet.

## Conversation history

The sidebar offers conversation history. Archive stores an inactive local Claude/Codex
conversation before closing its native tab; Restore reuses the saved session and
account command without resending its prompt. Failed or unconfirmed starts keep the
history entry. Archival supports local macOS/Linux sessions with one resumable root
per tab; Windows identity lookup and remote archival are not supported. Launch
commands with positional startup prompts or literal credential environment values
are rejected without closing the thread.

## Repository accounts

The Git actions menu offers GitHub account… for the selected repository and machine.
Review the commit author and Save to apply repository-local author settings and the
account choice; Cancel keeps the prior choice. GitHub accounts come from the machine's
existing GitHub CLI sign-ins.
