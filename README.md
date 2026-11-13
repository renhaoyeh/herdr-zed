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

## Shared Skills

Open **Agents → Capabilities → Overview → Import skill…** and choose a local skill folder containing
`SKILL.md` with its name/description frontmatter and any supporting files. For a skill from Git, clone
its repository first and choose the individual skill folder. Import records the source folder and content
revision; **Update from source** copies its current contents again, without running scripts or pulling Git.
Apply pending settings edits before importing or updating.

Browse **Claude Code** or **Codex** to choose shared skills independently. New shared items default on;
project overrides can be previewed/applied through the built-in `herdr_ecc` tools using `sharedSkills`
with the library's `mine:skills:*` or `mine:rules:*` IDs. These choices work independently of ECC's switch.

In **New thread**, type `/` at the start of the task to search available Shared Skills and built-in skills
for the selected program/project. Use Up/Down and Enter/Tab, or click an entry, then describe the task after
`/name `. Escape dismisses the list. Starting the thread resolves the skill against that launch's fixed
version; a removed/disabled skill is rejected with the draft kept for editing.

An optional `herdr.json` beside `SKILL.md` declares dependencies and supported providers/platforms:

```json
{
  "version": 1,
  "providers": ["claude", "codex"],
  "platforms": ["windows"],
  "mcps": ["visual_studio"]
}
```

Omit providers/platforms for all, and mcps for an ordinary skill. Missing or disabled MCPs show setup
requirements; configure them in **MCP Connections**. Skill selection never installs or enables a server.
New local sessions load a native plugin with fixed skill versions and supporting files. Running sessions
keep their version. Account sign-ins remain separate; remote sessions do not use this local library.

The library lives under `<Herdr home>/data/herdr-zed/capabilities/`, selections in `shared-skills.json`,
and immutable launch files in `skill-snapshots/` and `skill-packages/` under the same product data root.

## Development

```sh
npm test              # sync check, typecheck, all tests (test/*.test.js)
npm run sync:shared   # copy components/ into each mod that uses them (COPIES lists them)
npm run typecheck     # needs Herdr's herdr.d.ts in HERDR_APP_HOME
```

Edit shared components only in `components/`, then run `npm run sync:shared`. Run `herdr-app check` for each
changed mod. Architecture and phase status: [ARCHITECTURE.md](ARCHITECTURE.md). Conventions: [AGENTS.md](AGENTS.md).
