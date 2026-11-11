---
name: visual-studio
description: Build or rebuild the intended Visual Studio solution through an available visual_studio MCP on Windows.
---

## Visual Studio builds

- When the user has Visual Studio MCP installed and its tools are available, prefer the `visual_studio` MCP for Visual Studio solution and project builds.
- Before building through MCP, list Visual Studio instances, connect to the intended instance, and verify that its solution path matches the target solution.
- When a requested build or rebuild requires stopping an active debugging session, use Visual Studio MCP to stop debugging and proceed with the build. Treat this as part of the requested build workflow unless the user asks to preserve the debugging session.
- Use the build results and diagnostics returned by MCP to guide further work.

Windows only. Devkits → MCP → Setup can detect and verify the installed bridge after official VSIX installation. Setup does not start Visual Studio or connect to a solution automatically.
