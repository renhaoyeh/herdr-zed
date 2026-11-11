# Reference sources

`everything-claude-code/` is a Git submodule of [Everything Claude Code](https://github.com/affaan-m/everything-claude-code),
pinned to commit `d2ef2680594f9a17526a6e1a2e18b3d242c5d17b`.

After cloning herdr-zed, fetch the pinned source with:

```sh
git submodule update --init --recursive
```

The upstream source is available for integration and reference. Adding the submodule does not install its hooks,
skills, MCP servers or account configuration. When the Agents extension is installed
(`node install.js --extension herdr-zed-agents`) and `data/devkits/ecc-source` does not exist yet, the installer copies
this source there for the global ECC settings. An existing copy is never overwritten. Tests are scoped to
`test/*.test.js`, so upstream tests do not run as part of this repository's checks.
