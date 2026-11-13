# Herdr XD

Node 22+ stdio MCP packaged as an optional Herdr tool mod. No persistent UI or HTTP server.

Install with `node install.js --extension herdr-zed-xd`, then run `node "<Herdr home>/mods/herdr-zed-xd/setup-mcp.js" "<Herdr home>"`. Explicit setup preserves other entries, backs up an existing file, refuses a conflicting connection and is idempotent. It adds this existing-schema Shared MCP entry under `servers` in `<Herdr home>/data/herdr-zed/shared-mcp.json`:

```json
"herdr_xd": {
  "command": "node",
  "args": ["<Herdr home>/mods/herdr-zed-xd/mcp-server.cjs", "<Herdr home>"],
  "tool_timeout_sec": 180
}
```

New local Codex and Claude sessions receive it through the existing Shared MCP mechanism. Existing conversations do not reload their tools. Toggle the connection in Agents → MCP Connections; the extension switch does not control a separately registered Shared MCP entry. This follows the existing Codex account synchronization behavior; it is not restricted to Herdr-only invocations.

Tools: `inspect_xd({source, artboard?})`, `get_node({source, artboard?, node, depth?})`, `export_xd({source, artboard?})`, `verify_xd({directory})`.

Start with inspect to list artboards. Use an exact artboard ID to inspect a tree or export. `source` accepts an Adobe prototype JSON/manifest URL, a public XD page with embedded JSON, or a local snapshot directory. Sharing pages with no exposed embedded manifest return an explicit unsupported-source error; password/login flows are not implemented. Snapshots contain `prototype.json`, `artboard.json`, `interactions.json`, `globalResources.json`, `reference.png` and `<resource uid>.png` (existing experiment format). A snapshot may list other artboards whose AGC has not been downloaded; those return unavailable rather than exporting the wrong board.

Exports live in `data/herdr-zed/xd/exports/xd-*` and embed their images; no project files or account credentials are read or modified by the endpoint. Share tokens are used only for fetching, not included in results or exported HTML. Missing images are reported. HTML uses a restrictive CSP and never runs source JavaScript.

Verification requires installed Chrome/Edge; `XD_CHROME_PATH` can select an executable. It uses a fresh disposable headless profile and never focuses a window. Only exports under this Herdr home's export root can be verified. `pass` reports supported checks; `complete` additionally checks unresolved states, unsupported shapes and missing resources. Neither claims full fidelity. Preview rendering remains fixed-coordinate, uses local fonts and does not interpolate auto-animate. Alpha/image masks and some geometry remain unsupported.
