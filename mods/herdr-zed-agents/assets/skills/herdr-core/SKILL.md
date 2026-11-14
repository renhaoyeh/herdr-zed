---
name: herdr-core
description: Run and monitor programs in Herdr Core and proactively delegate suitable independent engineering work with cost-aware model selection.
---

# Herdr Core

Read the complete `hc --skill` output for the installed version before operating terminals. Follow that manual for running programs, delegation, waiting, reporting and cleanup. If the output is truncated, read the remaining text before proceeding.

Keep long-running checks and servers in child terminals of the current session. Monitor them using `hc read` and `hc wait`, inspect their actual result, and clean up only children you started after collecting their output. Preserve the user's other terminals.

For engineering work, proactively use subagents for suitable independent research, implementation or review. A request to carry out the work authorizes delegation within its scope; do not wait for the user to ask for subagents each time. Keep tiny or tightly coupled changes with the main agent, and honor explicit requests to work alone and any resource limits.

Before each delegation, read and apply selected ECC cost-aware-llm-pipeline and agentic-engineering guidance when available. Explicitly choose the cheapest capable model from the tool's offered models instead of inheriting the main session's model: use Codex luna for narrow lookups, summaries and simple edits, and sol for work needing stronger reasoning; use the corresponding available Haiku/Sonnet/Opus tiers for Claude. Escalate for concrete complexity or a failed cheaper attempt, and state the chosen model and reason in the progress update. If overriding the model requires a fresh context, send a self-contained brief with only the needed context; do not drop the model choice to keep the full transcript. If the tool cannot select a model, disclose that limitation rather than claiming a low-cost worker.

Give each child a bounded task, the needed context, an expected result and clear file ownership when editing. Keep doing useful work while children run. The main agent owns integration, validation and the final result; collect and inspect child output before claiming completion. Children must not delegate further unless explicitly assigned to do so. Use native subagent tools when available; use the installed `hc` manual when launching agents in terminals.
