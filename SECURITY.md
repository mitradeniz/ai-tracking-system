# Security

AI Tracking System is a local tool: the tracker and the desktop app run on your machine and talk only to `127.0.0.1`. There is no account, no telemetry and no remote service.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: **Security → Report a vulnerability** on this repository. Do not open a public issue for security problems. Include the version, your platform, steps to reproduce and the impact you expect. We aim to acknowledge reports within a week.

## Threat model

Trusted: you, and programs running as your user (they can already read and write your files). AI agents you choose to run get the access level you give them.
Not trusted: web pages open in any browser, and the content of reports and project files.

What the tracker does about it:

- **Loopback only.** The HTTP server binds to `127.0.0.1`.
- **DNS rebinding.** Requests whose `Host` header is not `127.0.0.1`, `localhost` or `[::1]` on the tracker's port are refused (`421`).
- **CSRF.** State-changing requests that carry a foreign `Origin` are refused (`403`), and they must be `application/json`, which a page cannot send cross-origin without a CORS preflight the tracker never approves.
- **Content Security Policy** and `nosniff`, `same-origin` opener and resource policies on every page.
- **Reports are data.** They are validated against a schema with length limits, stored as events, and rendered as text. Nothing in a report or project file is executed, and Markdown/HTML in them is not rendered.
- **File writes** happen only where you point them: the data directory (`~/.aitrack` or `AITRACK_DATA_DIR`), export targets ending in `.aitrack` or `.json`, and moving processed inbox files into `processed/` or `rejected/` next to them.
- **Desktop app.** The window runs with `contextIsolation`, `sandbox` and no Node integration. The preload bridge exposes only open/save/folder dialogs, "show in folder", moving a listed project's `.aitrack` file to the Trash, the floating window, updates and the control token; IPC handlers check that the caller is the tracker's own page. Navigation away from the tracker opens in your default browser instead.
- **Agent runners.** Starting an agent runs a program as you, so: run settings (which CLI, folder, access, custom command) live only in `~/.aitrack/runners.json` (mode 600) and are never read from project files; the endpoints that start, reply to, stop or configure runs require the control token from `~/.aitrack/control-token` (mode 600) in the `X-Aitrack-Token` header, which other local users and web pages do not have. Hooks and reports can only change task status. Agents run with the access level you chose (by default Codex's workspace-write sandbox, Claude Code's `acceptEdits`); "full access" turns those protections off and is marked as dangerous in the app.
- **Updates.** The app runs only `update-macos.command` from the clone recorded by its own installer in `~/.aitrack/install.json` (the folder must be a git clone that contains it). Checking is `git fetch` against the branch the clone already follows; updating pulls fast-forward only, stops on any local change except a lone `package-lock.json` rewrite, and rebuilds from the committed lockfile. Nothing is downloaded from anywhere except through git and npm, and the update endpoints are reachable only through the desktop app's IPC, not over HTTP.
- **Planning with AI.** The new-project wizard's *Create with AI here* starts an AI CLI, so it needs the control token like any run. The CLI runs in the project's folder in its read-only mode (Codex `read-only` sandbox, Claude Code's default mode with file-writing tools disallowed, Gemini's plan mode, Copilot without write tools) and only its answer is used; the answer is validated before anything is written. The wizard's folder check returns whether a folder exists, whether it is a git repository and the names of `.aitrack` files in it, nothing else.

## What you should do

- Do not put secrets, tokens or personal data in `.aitrack` files, prompts or reports. Project files are meant to be committed.
- Keep `.aitrack/inbox/` in `.gitignore`.
- Remember that the prompts you paste into AI chats leave your machine with those chats.
- Prefer the default access levels for chats that run themselves, and a separate git worktree per chat. Use "full access" only in a disposable environment.
