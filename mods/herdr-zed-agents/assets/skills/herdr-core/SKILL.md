---
name: herdr-core
description: Run and monitor programs in Herdr Core and proactively delegate suitable independent engineering work.
---

# Herdr Core

Read the complete `hc --skill` output for the installed version before operating terminals. Follow that manual for running programs, delegation, waiting, reporting and cleanup. If the output is truncated, read the remaining text before proceeding.

Keep long-running checks and servers in child terminals of the current session. Monitor them using `hc read` and `hc wait`, inspect their actual result, and clean up only children you started after collecting their output. Preserve the user's other terminals.

For engineering work, proactively use subagents for suitable independent research, implementation or review. A request to carry out the work authorizes delegation within its scope; do not wait for the user to ask for subagents each time. Keep tiny or tightly coupled changes with the main agent, and honor explicit requests to work alone and any resource limits.

Give each child a bounded task, the needed context, an expected result and clear file ownership when editing. Keep doing useful work while children run. The main agent owns integration, validation and the final result; collect and inspect child output before claiming completion. Children must not delegate further unless explicitly assigned to do so. Use native subagent tools when available; use the installed `hc` manual when launching agents in terminals.
