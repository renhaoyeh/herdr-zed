# Development Guidelines

This repository builds herdr-zed: a Zed-style Herdr shell and the provider mods it hosts.
[ARCHITECTURE.md](ARCHITECTURE.md) defines layers, contracts, data paths and the move plan; read it
before changing structure or cross-mod behavior.

## Inherited rules

The Devkits design and development rules still apply until they are brought into this repository:
the devkits repository's `design.md` (Sera UI defaults, interaction rules) and `herdr/DEVELOPMENT.md`
(native API references, smallest complete change, `theme()` tokens, native async/animation, checks).
Where they mention the Devkits layout or `mods/devkits`, the rules below take precedence.
This repository's [design.md](design.md) (Settings, status bar, dialog types, terms) overrides the devkits
`design.md` where they differ; read it before UI changes.

## Source repository

- The devkits repository is in daily use. Read it only: never edit, commit, rewrite history, run filter tools in
  place, reinstall, or change/switch the layout it installed. Run history filtering on a fresh clone.

## Structure

- Shell code lives only in `mods/herdr-zed/`. It imports no provider code and has no provider-specific
  branches; providers are reached only through `extension.json` and the messages in ARCHITECTURE.md §3.
- Each provider keeps its implementation, assets and UI in its own mod. Dependencies follow the layer table.
- One code path: no compatibility branches, fallbacks or key migrations for the old Devkits layout.
- Edit shared components only in `components/`, then run `npm run sync:shared`; `mods/*/components/` hold
  copies. Add a `COPIES` line when a mod starts using a component. Icons live in `assets/icons/`.
- Changing the manifest schema or a message format changes the parser, every manifest and the contract
  tests in the same commit. Manifests stay `version: 1`.
- Shared-state keys use the `herdr-zed.` prefix. All product data lives in `data/herdr-zed/`,
  including accounts, MCP, ECC settings, connections, caches and the Guide. Never read or modify
  Devkits data; do not migrate it automatically.

## Validation

- `npm test` (runs `sync:shared -- --check`, `typecheck`, then the tests) and `herdr-app check` for every changed mod.
- Types: write JavaScript with JSDoc; there is no build step. Files opt in with `// @ts-check`; contract code
  (`components/extension-contract.js`, `mods/herdr-zed/extension-model.js`) must stay checked. Contract types
  live in `components/contract-types.d.ts`. `npm run typecheck` copies Herdr's `herdr.d.ts`/`gpui-kit.d.ts` from
  `HERDR_APP_HOME` (default `~/.config/herdr-app`) into the ignored `types/herdr/`; never edit those files.
- Use mocked native APIs and temporary Herdr homes. Never launch agents or modify real projects,
  sessions, account data or the user's installed layouts to verify a change.
- Keep previews and UI tests in the background. Never activate, raise or focus a test window over the user's current
  window. Dispatch test input only inside the isolated test process; if a check requires foreground focus, report that
  limitation instead of taking focus from the user.

## Commit messages

- Conventional Commits: `<type>(<optional scope>): <description>`, English imperative, types `feat`, `fix`,
  `refactor`, `docs`, `test`, `chore`. Scopes are mod or area names, e.g. `feat(shell): validate launch requests`,
  `refactor(agents): merge usage provider`.
- History-preserving moves keep the original commits; add a separate commit for path or name changes.
