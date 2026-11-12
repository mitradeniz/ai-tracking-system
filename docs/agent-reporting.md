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

Text fields are limited to 20 000 characters (`pr`: 2 000). Inbox files and pasted text may also hold a JSON array of reports.

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

Options: `--project`, `--agent`, `--summary`, `--reason`, `--pr`, `--verify`, `--server` (default `$AITRACK_SERVER` or `http://127.0.0.1:4317`), `--inbox` (default `<repo root>/.aitrack/inbox`), `--no-http`.

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
