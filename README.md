# herdr-zed

A Zed-style shell for [Herdr](https://herdr.dev): project and thread sidebar, terminal panes, Files, Git,
previews and editor tabs. Provider features (Agents, Tasks, Calendar, Usage, integrations, System, Simulator)
are optional extension packages the shell reaches only through their `extension.json` declarations.

| Layer | Mods | Role |
| --- | --- | --- |
| Shell | `herdr-zed` | Projects, threads, Files, Git, previews, panes, extension registry |
| Agent Runtime | `herdr-zed-agents` | Accounts, Profiles, Rules, Shared MCP, launch preparation, usage |
| Work | `herdr-zed-tasks`, `herdr-zed-calendar` | Tasks and the Calendar view over the Tasks read model |
| Integrations | `herdr-zed-asana`, `herdr-zed-mantisbt`, `herdr-zed-github` | Source browsers and imports, GitHub accounts |
| Other | `herdr-zed-system`, `herdr-zed-simulator`, `herdr-zed-sim-frames` | System monitor, iOS Simulator and its frames |

Mods only depend on the layers below them; the shell imports no provider code.

## Install

Requires Node.js 22.13 or later. Run from the repository root. `HERDR_APP_HOME` selects the Herdr home
(default `~/.config/herdr-app`).

```sh
git submodule update --init --recursive   # ECC source, needed for the Agents extension
npm install
npm run install:herdr                     # shell: mods/herdr-zed, layouts/herdr-zed.json, missing themes, shortcuts
npm run install:extension -- herdr-zed-tasks   # register a provider package (and its dependencies)
```

The first install never switches the current layout and refuses to overwrite an existing shell or layout.
Choose the `herdr-zed` layout in Herdr to use it.

## Update

```sh
npm run update:herdr
```

Refreshes every installed `herdr-zed*` mod, the layout and the shell icons from this repository. The replaced
files are moved to `backups/herdr-zed-<stamp>/` first and restored if an update step fails. `data/`, shortcuts,
settings and any mod, layout or theme that is not part of herdr-zed are left alone.

## Development

```sh
npm test              # sync check, typecheck, all tests (test/*.test.js)
npm run sync:shared   # copy components/ into each mod that uses them (COPIES lists them)
npm run typecheck     # needs Herdr's herdr.d.ts in HERDR_APP_HOME
```

Edit shared components only in `components/`, then run `npm run sync:shared`. Run `herdr-app check` for each
changed mod. Architecture and phase status: [ARCHITECTURE.md](ARCHITECTURE.md). Conventions: [AGENTS.md](AGENTS.md).
