---
name: herdr-core
description: Run and monitor programs in Herdr Core when working in a Devkits session, including long-running checks and servers.
---

# Herdr Core

Read the complete `hc --skill` output for the installed version before operating terminals. Follow that manual for running programs, delegation, waiting, reporting and cleanup. If the output is truncated, read the remaining text before proceeding.

Keep long-running checks and servers in child terminals of the current session. Monitor them using `hc read` and `hc wait`, inspect their actual result, and clean up only children you started after collecting their output. Preserve the user's other terminals.

Running programs does not grant permission to delegate work. Use agents only when the user's task or applicable instructions authorize it.
