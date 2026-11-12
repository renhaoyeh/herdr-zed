---
name: shared-mcp
description: Follow the shared installation and credential policy when the user requests installing, changing or diagnosing a Herdr Devkits MCP connection.
---

## MCP installation

For local MCP setup supported by Herdr Devkits' shared MCP mechanism, default to the shared configuration at `<Herdr home>/data/herdr-zed/codex-mcp.json`. Resolve Herdr home from `HERDR_APP_HOME` when set, otherwise `~/.config/herdr-app`. Confirm the current launcher supports this mechanism before claiming the MCP is available to it.

Inspect the existing shared configuration and its supported schema before editing. Preserve unrelated entries and keep the existing version/servers structure. Do not default to the current account's configuration or the agent's default home directory. Herdr synchronizes shared MCP settings into supported accounts when new local sessions start; do not claim an existing session has reloaded them.

Install reusable MCP runtimes in a shared location when supported by their setup, and register their command or local URL in the shared configuration. If setup writes only to the current account, add the intended registration to the shared configuration and remove only the duplicate entry that this setup just created. Preserve pre-existing account settings.

Keep account-authorized remote services in their account configuration. Use account-specific settings only when explicitly requested or required by the integration. Use supported environment-variable references for shared credentials rather than literal secrets.
