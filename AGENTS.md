# Development Guidelines

This repository builds herdr-zed: a Zed-style Herdr shell and the provider mods it hosts.
[ARCHITECTURE.md](ARCHITECTURE.md) defines layers, contracts, data paths and the move plan; read it
before changing structure or cross-mod behavior.

## Inherited rules

The Devkits design and development rules still apply until they are brought into this repository:
the devkits repository's `design.md` (Sera UI defaults, interaction rules) and `herdr/DEVELOPMENT.md`
(native API references, smallest complete change, `theme()` tokens, native async/animation, checks).
Where they mention the Devkits layout or `mods/devkits`, the rules below take precedence.

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
- Shared-state keys use the `herdr-zed.` prefix (final prefix depends on the naming decision).

## Validation

- `npm test` (includes `sync:shared -- --check`) and `herdr-app check` for every changed mod.
- Use mocked native APIs and temporary Herdr homes. Never launch agents or modify real projects,
  sessions, account data or the user's installed layouts to verify a change.

## Commit messages

- Conventional Commits: `<type>(<optional scope>): <description>`, English imperative, types `feat`, `fix`,
  `refactor`, `docs`, `test`, `chore`. Scopes are mod or area names, e.g. `feat(shell): validate launch requests`,
  `refactor(agents): merge usage provider`.
- History-preserving moves keep the original commits; add a separate commit for path or name changes.
