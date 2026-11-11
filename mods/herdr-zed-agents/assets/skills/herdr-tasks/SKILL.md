---
name: herdr-tasks
description: Use Herdr Tasks MCP to inspect or create local tasks and report progress while carrying out actual user work. Ordinary chat and discussion do not require progress reporting.
---

# Herdr Tasks

Discover the `herdr_tasks` MCP tool descriptions and schemas before calling them. Use the supplied attempt ID when present.

For inspection or creation, determine the exact local project folder first. Use `list_tasks` for that project to find existing work and avoid duplicates. Create a Todo only when the user's request authorizes creating one, using `create_task`; creation does not start an agent. Use a returned task identity for relationships rather than guessing IDs.

If creation times out, inspect the project tasks before retrying: the original creation may have succeeded. Report progress for the current session or attempt only; do not edit Herdr's shared state files or report on behalf of other terminals.

## Progress reporting

Apply progress reporting when carrying out an actual user task. Ordinary chat, brainstorming and discussion do not require reports.

Use the `herdr_tasks` MCP server for local task progress. Discover its `report_task` tool and read the tool's description and input schema before starting actual user work. No local script path or shell command is needed.

Report `doing` before work and when resuming after an answer. Report `waiting` before asking the user a question, with the exact question in the message. Report `done` only when the whole task is complete, including its result, validation and remaining limitations; report `fail` when the attempt cannot be completed, explaining why and what was preserved. Ending a reply or a native terminal turn is not task completion. Do not report startup without a user task.

Call `report_task` with `status` and `message`. When the task prompt supplies a run ID, pass it unchanged in `run` for that attempt. Otherwise omit `run`: the MCP server binds reports to your own live HC terminal. Never report for another terminal or edit Herdr shared.json directly. If the MCP tool is unavailable or reporting fails, continue authorized work and mention the failure in your final response; do not guess a local script path.
