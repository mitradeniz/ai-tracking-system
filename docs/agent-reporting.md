# Reporting from an agent

Every task prompt copied from the app ends with a **REPORTING** section, so you normally do not need to explain any of this to a chat. This page is the reference for that section, for custom `templates.report`, and for tools that want to report programmatically.

## The report

```json
{
  "project": "landing-page",
  "task": "T-03",
  "agent": "codex-a",
  "status": "done",
  "summary": "Tokens and Button/Input/Field/Card with stories and axe checks.",
  "pr": "https://github.com/acme/web/pull/42",
  "verify": "npm run storybook, open Components/Field"
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `task` | yes | Task id from the `.aitrack` file. |
| `status` | yes | `started`, `progress`, `blocked`, `review`, `done` or `failed`. |
| `project` | no | Project id. Needed only when several open projects have the same task id. |
| `agent` | no | Chat id. Defaults to the chat the task was sent to, or its owner. |
| `summary` / `message` | no | What changed (`done`) or what is happening (`progress`). |
| `reason` | for `blocked` / `failed` | Why. Shown on the board. |
| `pr` | no | Pull request URL or branch. |
| `verify` | no | How a human can check the result. |
| `issues` | no | Problems: what failed or what a person must do or decide. See below. |
| `followUps` | no | Work left for later, proposed as new tasks. See below. |
| `waitingFor` | no | With `blocked`: ids of tasks of the plan the chat waits for. See below. |

Text fields are limited to 20 000 characters (`pr`: 2 000). Inbox files and pasted text may also hold a JSON array of reports.

### Waiting for another task (`waitingFor`)

A chat that cannot go on until another task of the plan is done — its code merged, its contract written — reports `blocked` with the ids of those tasks:

```json
{"task": "CLA-01", "status": "blocked", "reason": "The PRs open once CLD-01 is merged.", "waitingFor": ["CLD-01"]}
```

The task then needs nothing from the person: it shows as *waiting for CLD-01*, keeps its chat (which takes no other task meanwhile, so it finishes what it started in the same conversation), raises no problem, and the ids become dependencies of the task in the plan file, so it is not sent too early next time (one that would make a cycle is left out; a note in the task's history says what was added). When every task it waits for is done, the task is ready again for the same chat, ahead of the chat's other work; with automatic dispatch it is sent at once, with a note that lists what was finished (summary and PR) and asks the chat to go on where it stopped. A task waited for that was already done when the chat stopped does not count: the task stays blocked for the person. `"waitingFor": "CLD-01"` (one id) is read too.

### Work left for later (`followUps`)

A chat that worked around something — a placeholder instead of an image another tool could not make, a check it had no time to add — finishes its task and writes down the rest, instead of stopping for the person:

```json
"followUps": [
  {"title": "Replace the placeholder images", "detail": "web/img/*.svg are placeholders until the reference pack exists.", "agent": "codex-c", "after": ["T-05"]}
]
```

Only `title` is needed; `agent` is the chat that should do it, `after` the tasks it must wait for (one id is read too). Each one becomes a **proposed task**: the board shows *Chats left N tasks for later*, and the task drawer lists them too. A proposal can be **added to the plan** (a new task `<task>-F1`, … for the chosen chat, depending on the task it came from and on `after`, with the prompts and milestone of that task), **ignored** (and brought back later), or folded in with the others by an AI CLI: **Fold into the current plan** sends the plan, the open proposals and the open notes to Claude Code, Codex, Gemini or Copilot, which answers with new tasks, links to tasks that already cover a proposal, and proposals to ignore; the app checks the answer (known chats, existing dependencies, no cycles) and shows it before anything is written. The same work proposed again by the same task is not listed twice. With the CLI: `--follow-ups '[{"title":"…"}]'`. API: `POST /api/projects/:key/proposals/add` (`{id, agent?}`), `…/proposals/state` (`{ids, state: "ignored" | "open"}`), `…/proposals/integrate` (`{provider, model?}`, a job like the plan generator's), `…/proposals/preview` (`{answer}`) and `…/proposals/apply` (`{plan}`).

### Problems (`issues`)

A report can list what did not go as planned, so it is not buried in the summary:

```json
"issues": [
  {
    "title": "Stripe test key missing, payment step not tried",
    "detail": "STRIPE_SECRET_KEY is not set; the flow is written but not tested end to end.",
    "kind": "needs-you",
    "fix": "STRIPE_SECRET_KEY is now set in .env.local. Run the payment flow end to end, fix what fails and report again."
  }
]
```

`kind` is `error` (default), `missing`, `needs-you` or `warning`. A `warning` is a **note**: it needs no answer, raises no **!**, and is listed under *Notes* in the task drawer, where it can be marked seen or folded into the plan with the proposals; anything else is a problem for the person, so the prompt asks chats to report only what failed or what a person must do or decide, to write work for later as `followUps` and plain information in the `summary`; `fix` is a prompt that would solve it. A decision only the person can make can carry `choices`, up to five options shown as buttons, the recommended one first: `"choices": [{"label": "Separate repository", "reply": "I move the commits there and go on.", "recommended": true}, {"label": "Same repository"}]`. `label` is the button, `reply` what the chat is told when it is picked (the label when left out). The task prompt asks chats to write `title` and `detail` in the project's language (`settings.language`), in plain words. The app marks such tasks with a red **!**, lists the problems in the task drawer and keeps each fix prompt ready to copy or send to the chat. Problems stay until the task is sent again, reported `done` without problems, approved or reopened; a report with `"issues": []` clears them. In the drawer each one can be marked **Resolved** or **Ignore**d (`POST /api/projects/:key/tasks/:task/issues` with `{index, title, state: "resolved" | "ignored" | "open"}`, or `{issues: [{index, title}, …], state}` for several in one event); a closed problem no longer counts, is listed under *Resolved and ignored* and can be opened again. With the CLI: `--issues '[{"title":"…","fix":"…"}]'`.

Reports are read leniently: `null` means a field is not set, an unknown `kind` falls back to `error`, and when a chat forgets the `aitrack-report` fence, a JSON object with `task` and `status` in its final message (or in a ```` ```json ```` block) is taken as the report.

| Status | Effect on the board |
| --- | --- |
| `started`, `progress` | In progress. The chat stays busy. |
| `blocked` | Blocked, with the reason. The chat stays busy until it reports again or you reopen the task. |
| `review` | In review; waits for your approval. Frees the chat. |
| `done` | Done — or In review when the project has `requireApproval: true`. Dependents may turn green. |
| `failed` | Failed, with the reason. Frees the chat; the task is not sent again until you reopen it. |

## Channels

Use the first one that works. All four end up as the same event in the log.

### 1. HTTP

```bash
curl -s -X POST http://127.0.0.1:4317/api/report \
  -H "Content-Type: application/json" \
  -d '{"task":"T-03","status":"started"}'
```

Response:

```json
{ "ok": true, "key": "p-1a2b3c4d5e6f", "task": "T-03", "status": "in_progress", "next": [{ "id": "T-06", "title": "Landing page" }] }
```

`next` lists the tasks this chat could take next, most urgent first. The status code is `201`. Errors: `400` invalid report, `404` no open project has the task, `409` the task id exists in several projects (add `project`).

The tracker only accepts requests addressed to a loopback host with `Content-Type: application/json`, and refuses cross-origin browser requests. See [SECURITY.md](../SECURITY.md).

### 2. The `aitrack-report` CLI

A zero-dependency Node.js script in this repository (`packages/reporter/bin/aitrack-report.mjs`, Node 18+). It posts to the tracker and, if that fails, writes the inbox file for you:

```bash
node /path/to/ai-tracking-system/packages/reporter/bin/aitrack-report.mjs \
  --task T-03 --status blocked --reason "Needs the colour palette from T-01"
```

Options: `--project`, `--agent`, `--summary`, `--reason`, `--pr`, `--verify`, `--issues <json>`, `--follow-ups <json>`, `--waiting-for <ids>` (comma-separated), `--server` (default `$AITRACK_SERVER` or `http://127.0.0.1:4317`), `--inbox` (default `<repo root>/.aitrack/inbox`), `--no-http`.

### 3. Inbox file

For chats that run in a sandbox without access to your localhost (cloud agents, containers): write the report JSON to a new file in the repository:

```text
.aitrack/inbox/T-03-done-1762962000000.json
```

The tracker scans, every few seconds, the inbox of the repository that holds the `.aitrack` file and — when `settings.repoPath` is set — of that repository and all its `git worktree`s. Processed files move to `.aitrack/inbox/processed/`; invalid ones to `.aitrack/inbox/rejected/` with an `.error.txt` next to them. Keep `.aitrack/inbox/` in `.gitignore`.

A cloud agent working on a remote branch cannot reach your disk; use channel 4 for those.

### 4. Paste

Every prompt asks the chat to end its final message with a fenced block:

````text
```aitrack-report
{"project":"landing-page","task":"T-03","agent":"codex-a","status":"done","summary":"…","pr":"…","verify":"…"}
```
````

Copy the chat's last message (or just the block) into **Paste report** in the app. Several blocks in one paste are fine.

### 5. Run output and hooks

A chat that [runs by itself](agent-runners.md) does not need any of the above: the tracker starts it and reads the `aitrack-report` block from its final message (`source: "runner"`). Sessions you open by hand in Claude Code or Codex can send their turn starts and ends through a [hook](agent-runners.md#hooks-for-sessions-you-open-yourself) (`source: "hook"`).

## Marking by hand

Every state can also be set from the task drawer: mark sent, started, done, blocked (with a reason), failed, approve, reopen, or add a note. Manual changes are events too, with `source: "ui"`.
