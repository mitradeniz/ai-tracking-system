# The `.aitrack` file format (version 1)

An `.aitrack` file is a UTF-8 JSON document that describes one project: the chats that work on it, the tasks, the dependencies between tasks and the prompts to paste. It is meant to live in the project's repository and be reviewed like code.

- Extension: `.aitrack` (plain `.json` is accepted too)
- Media type used by the desktop app: `application/vnd.aitrack+json`
- JSON Schema: [`schema/aitrack.schema.json`](../schema/aitrack.schema.json) — add `"$schema"` to get completion in editors
- Source of truth: [`packages/core/src/schema.ts`](../packages/core/src/schema.ts)

## Top level

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `$schema` | string | no | URL of the JSON Schema, for editors. |
| `format` | `"aitrack"` | yes | Identifies the file type. |
| `version` | `1` | yes | Format version. |
| `project` | object | yes | `id`, `name`, optional `description` and `links: [{label, url}]`. |
| `settings` | object | no | See [Settings](#settings). |
| `agents` | array | no (default `[]`) | The chats. See [Agents](#agents). A new project may start without chats or tasks. |
| `tasks` | array | no (default `[]`) | See [Tasks](#tasks). |
| `prompts` | object | no | Map of prompt id → `{ title?, body }`. |
| `templates` | object | no | `dispatch` and `report` templates. See [Templates](#templates). |
| `milestones` | array | no | `{ id, name, date?: "YYYY-MM-DD", description? }`. |
| `state` | object | no | Status snapshot written by **Export**. See [State snapshot](#state-snapshot). |

Ids (`project.id`, agent, task and milestone ids) may contain letters, digits, `.`, `_` and `-`, must start with a letter or digit, and are at most 80 characters. Task ids are case-sensitive.

## Agents

An agent is one chat session (or a person) that takes tasks.

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `id` | string | — | Used in tasks and reports, e.g. `codex-b`. |
| `name` | string | — | Display name, e.g. `Codex B`. |
| `tool` | string | — | Free text: `claude`, `codex`, `cursor`, `human`… |
| `role` | string | — | One line shown in the lane header. |
| `capabilities` | string[] | `[]` | Free-form tags, e.g. `computer-use`, `images`. |
| `color` | string | — | Optional CSS color. |
| `maxParallel` | integer 1–10 | `1` | How many tasks the chat may hold at once (sent, in progress or blocked). |
| `bootstrapPrompts` | string[] | `[]` | Prompt ids joined into the **session prompt**, pasted once when a chat session starts. |
| `quickPrompts` | string[] | `[]` | Prompt ids for recurring duties (reviews, QA rounds), shown as copy buttons on the lane. |

Chats can also be added, edited and removed in the app (**Add chat** at the end of the lanes, or the pencil on a lane). The app changes the file in place: it keeps key order and fields you left out, and removing a chat moves its tasks to another chat. Choosing "may also take tasks of" adds the chat to `alsoAgents` of those chats' tasks.

## Tasks

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `id` | string | — | e.g. `T-07`, `CLA-03`. |
| `title` | string | — | Short, imperative. |
| `description` | string | — | Shown in the drawer, not in the prompt. |
| `agent` | string | — | Owner chat id. |
| `alsoAgents` | string[] | `[]` | Other chats that may take the task when the owner is busy. |
| `dependsOn` | string[] | `[]` | Task ids that must be **done** first. Only real dependencies — this is what makes work parallel. |
| `prompts` | string[] | `[]` | Prompt ids whose bodies form the task prompt, in order. |
| `instructions` | string | — | Task-specific text appended after the prompts. |
| `scope` | string | — | Which part of a shared prompt this task covers (when one prompt is split into several tasks). |
| `allowedPaths` | string[] | `[]` | Paths the chat may change. Keeps parallel chats from colliding. |
| `acceptance` | string | — | How to tell the task is done. |
| `milestone` | string | — | Milestone id. |
| `estimateDays` | number | `1` for the critical path | Used to compute the critical path. |
| `tags` | string[] | `[]` | Free-form, filterable in the list view. |

A task needs at least one of `prompts` or `instructions` (otherwise a warning is shown).

### Validation

When a file is opened (and by `npm run validate`), these are **errors**: duplicate ids, unknown agent / prompt / milestone / dependency ids, a task depending on itself, and dependency cycles. Missing prompts and instructions are a **warning**.

## Settings

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `requireApproval` | boolean | `false` | When true, a task reported `done` goes to **In review** and only counts as done (unblocking dependents) after you approve it. |
| `inboxDir` | string | `.aitrack/inbox` | Directory, relative to a repository root, where agents can drop report files. Add it to `.gitignore`. |
| `repoPath` | string | — | Path of the code repository, relative to this file, when the file lives elsewhere (for example in a planning repo). The inbox of that repository and of all its `git worktree`s is scanned. |
| `language` | `"en"` \| `"tr"` | — | Hint for the UI language. |

## Prompts

`prompts` is a map from prompt id to `{ "title": "…", "body": "…" }`. Bodies are pasted as-is (they are not templates). Keep shared context, per-chat session prompts, task prompts and recurring duties (review, QA) as separate prompts and reference them by id.

## How a task prompt is built

When you copy a task, the app renders:

1. The `dispatch` template (or the default): task header, chat, milestone, scope, dependencies, allowed paths, working rules, acceptance.
2. The bodies of `task.prompts`, separated by `---`.
3. `task.instructions`.
4. The `report` template (or the default): how to report `started`, `blocked`, `done`, `failed` to the tracker.

The **session prompt** of a chat is the bodies of its `bootstrapPrompts`, in order.

## Templates

`templates.dispatch` and `templates.report` override the defaults in [`packages/core/src/prompt.ts`](../packages/core/src/prompt.ts). Placeholders use `{{name}}`; unknown names are left untouched so mistakes stay visible.

| Variable | Value |
| --- | --- |
| `{{project.id}}`, `{{project.name}}` | Project id and name. |
| `{{task.id}}`, `{{task.title}}`, `{{task.scope}}`, `{{task.acceptance}}` | Task fields. |
| `{{task.dependsOn}}`, `{{task.allowedPaths}}` | Comma-separated lists. |
| `{{agent.id}}`, `{{agent.name}}` | The chat the prompt is copied for. |
| `{{milestone}}`, `{{milestoneLine}}` | Milestone name (and date); the line form starts with ` · Milestone:`. |
| `{{scopeLine}}`, `{{dependenciesLine}}`, `{{allowedPathsLine}}`, `{{acceptanceLine}}` | Ready-made lines, empty when the field is empty. |
| `{{prompts}}` | The bodies of `task.prompts`. |
| `{{instructions}}` | `task.instructions`. |
| `{{report}}` | The rendered report template (dispatch template only). |
| `{{serverUrl}}` | Base URL of the local tracker, e.g. `http://127.0.0.1:4317`. |
| `{{inboxDir}}` | `settings.inboxDir`. |

## State snapshot

Status is not stored in the file while you work: the tracker keeps an append-only event log per project in its data directory (`~/.aitrack/events/<key>.jsonl`). **Export → include status** writes the events into the file:

```json
"state": {
  "exportedAt": "2026-11-12T15:43:00.000Z",
  "events": [
    { "id": "e-…", "ts": "2026-11-12T15:40:02.114Z", "task": "T-01", "agent": "codex-b", "type": "done", "message": "…", "source": "http" }
  ]
}
```

Event `type` is one of `dispatched`, `started`, `progress`, `blocked`, `review`, `done`, `approved`, `failed`, `reopened`, `note`. `source` is one of `ui`, `http`, `file`, `paste`, `import`. When a file with a snapshot is opened, events whose `id` the log does not have yet are imported, so opening the same snapshot twice is harmless.

Commit plan-only exports for review; commit snapshots only when you want to hand over a project's status.

## Editing in the app and over HTTP

The app edits the file in place and keeps the author's formatting: fields that were left out stay out, key order stays, and every change is checked before it is written (unknown ids, cycles). The same edits are available on the local tracker:

| Endpoint | Body | Does |
| --- | --- | --- |
| `POST /api/projects/create` | `{filePath, id, name, language?, agents?}` or `{filePath, text}` | Writes a new file (empty, or a checked file) and opens it. |
| `POST /api/projects/:key/tasks` | `{task, mode: "create" \| "update"}` | Adds or changes a task; only the fields given change, empty values remove optional fields. |
| `POST /api/projects/:key/tasks/:task/remove` | — | Removes a task; tasks that waited for it wait for what it waited for. Refused while it is with a chat. |
| `POST /api/projects/:key/prompts` | `{prompt: {id, title?, body}, mode}` | Adds or changes a prompt. |
| `POST /api/projects/:key/prompts/:prompt/remove` | — | Removes a prompt and every reference to it. |
| `POST /api/projects/:key/info` | `{name?, description?, language?, requireApproval?, repoPath?}` | Project name, description, language, approval and code folder (an absolute `repoPath` is stored relative to the file; `null` removes it). |
| `POST /api/projects/:key/plan` | `{text}` | Replaces the plan of a project that has no tasks yet (Plan with AI). |
| `POST /api/projects/:key/agents` · `…/agents/:chat/remove` | see the app | Adds, changes or removes a chat. |
| `POST /api/projects/:key/pin` · `POST /api/projects/order` | `{pinned}` · `{keys}` | Pins and orders the project list (kept in `~/.aitrack/registry.json`, not in the file). |
| `POST /api/authoring/prompt` · `POST /api/authoring/check` | `{input}` · `{answer, input}` | The instructions for an AI, and the check of its answer. See [Authoring a project with AI](authoring-with-ai.md). |

## Compatibility

Readers must reject files whose `format` is not `"aitrack"` or whose `version` they do not know. New optional fields may be added within version 1; removing or changing the meaning of a field requires version 2.
