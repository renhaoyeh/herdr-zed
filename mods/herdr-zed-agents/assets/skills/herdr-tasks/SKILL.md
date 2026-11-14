---
name: herdr-tasks
description: Use Herdr Tasks MCP to inspect or create local tasks and report progress while carrying out actual user work. Ordinary chat and discussion do not require progress reporting.
---

# Herdr Tasks

Discover the `herdr_tasks` MCP tool descriptions and schemas before calling them. Use the supplied attempt ID when present.

## Task creation and subtasks

For inspection or creation, determine the exact local project folder first. Use `list_projects` to get its exact project key, then `list_tasks` for that project to find existing work and avoid duplicates. Create a Todo with `create_task` only when the user's request authorizes creating one; reporting progress alone does not require a new Todo. Creating a Todo does not itself start execution; a request only to create or plan tasks is separate from a request to carry out the work.

When asked to split work into subtasks, reuse the existing parent identified by the user or the current task. Match it against `list_tasks`; if the reference is ambiguous, clarify before creating children. Create a parent only when the request calls for a new task and no matching parent exists. Use the parent's returned `gid` as `parentId` on each `create_task` call, with the same project key. The parent must exist in that project and be nonarchived; a subtask can itself be a parent.

Give each child a clear name and put its scope and completion criteria in `notes`. Check existing children under that `parentId` before adding more. Return the parent and created or reused child names and gids so the user can review the relationship. Creating or finishing a child does not complete its parent.

If creation times out, inspect the project tasks before retrying: the original creation may have succeeded. If only some children were created, keep them, report which ones exist and retry only missing work. Report progress for the current session or attempt only; do not edit Herdr's shared state files or report on behalf of other terminals.

## Progress reporting

Apply progress reporting when carrying out an actual user task. Ordinary chat, brainstorming and discussion do not require reports.

Use the `herdr_tasks` MCP server for local task progress. Discover its `report_task` tool and read the tool's description and input schema before starting actual user work. No local script path or shell command is needed.

Report `doing` before work and when resuming after an answer. Report `waiting` before asking the user a question, with the exact question in the message. Report `done` only when the whole task is complete, including its result, validation and remaining limitations; report `fail` when the attempt cannot be completed, explaining why and what was preserved. Ending a reply or a native terminal turn is not task completion. Do not report startup without a user task.

Call `report_task` with `status` and `message`. When the task prompt supplies a run ID, pass it unchanged in `run` for that attempt. Otherwise omit `run`: the MCP server binds reports to your own live HC terminal. Never report for another terminal or edit Herdr shared.json directly. If the MCP tool is unavailable or reporting fails, continue authorized work and mention the failure in your final response; do not guess a local script path.

When the prompt assigns a Supervisor stage, complete only that stage and report its exact run ID. Herdr starts the next stage in a separate conversation; do not start other agents or advance the parent yourself. Research and review stages are read only. A review reporting `done` must include `verdict: "pass"` or `verdict: "changes_requested"` based on the actual changes and validation, not just earlier agents' claims. A stage result does not complete the parent task; only a passing review sends it to user acceptance.
