# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Chats that run themselves: a chat can be set to run with Codex CLI, Claude Code, GitHub Copilot CLI, Gemini CLI or a custom command. **Send** starts or continues the chat's session in its folder with the task prompt; the output streams into the task drawer; the task goes *in progress* on the first output, *done* from the report in the final message, or *waiting for your reply* when the agent asks something. **Reply** continues the same session, **Stop** ends a run.
- Per-chat run settings stored only on this computer (`~/.aitrack/runners.json`): CLI, working folder, access level (read only, edit files, full access), same session or a new one per task, session id (paste one to continue an existing chat), "don't wait for plan approval", network for the Codex sandbox, extra allowed tools, model, extra arguments, program path. CLIs are found on the login shell's `PATH` and the usual install folders.
- Auto-dispatch per project: free chats that run themselves get their most urgent ready task, up to a limit of runs at once.
- Hooks for sessions opened by hand: `POST /api/hook` understands Claude Code hook payloads and Codex `notify`, marks tasks in progress / waiting for your reply / done, and learns the session id so Send continues that conversation. `aitrack-report hook` forwards a hook without curl.
- A control token for the endpoints that start programs; the desktop app hands it to its windows and `aitrack serve` prints a link with it.
- Model and reasoning effort per chat, picked from lists: Codex's model catalog with each model's reasoning levels, Copilot's model list, and the Claude Code and Gemini aliases that follow the latest versions; any other model id can be typed. Model names with spaces are refused instead of failing at run time.
- Event sources `runner` and `hook`. Runs interrupted by quitting the app are marked blocked on the next start.

## [0.1.0] - 2026-11-12

### Added

- `.aitrack` project file format, version 1, with JSON Schema and validation (duplicate and unknown ids, cycles).
- Task graph: readiness by dependencies and chat capacity, layers, critical path, "why not now" reasons.
- Local tracker on `127.0.0.1:4317`: project registry, append-only event log, live updates over SSE.
- Agent reporting over HTTP, the zero-dependency `aitrack-report` CLI, inbox files (including git worktrees) and pasted `aitrack-report` blocks.
- UI with lanes per chat, flow by dependency step, list with filters, and a task drawer with the chat to send to, the rendered prompt and the full history. English and Turkish.
- Session prompts and quick prompts per chat; manual status changes, approval and notes.
- Export to `.aitrack` with an optional status snapshot; importing a snapshot is idempotent.
- Electron desktop app with `.aitrack` file association and installers via electron-builder.
- `install-macos.command`: double-click installer that builds the app, installs it in Applications and registers `.aitrack` files.
- Add, edit and remove chats from the app. A chat can be allowed to take the tasks of other chats; edits keep the project file's formatting and fields that were left out.
- Black liquid glass design: monochrome frosted surfaces, soft status colours, light theme in white glass; monochrome app icon.
- Screens built from panels (ready to send, chat lanes, flow, list, needs you, recent activity, progress): add, move by drag or arrows, resize, filter by chat; several named layouts, stored per user.
- Floating window: frameless, always on top, on every desktop, with project picker, overview / compact list / mini lanes, selectable sections and chats, one-click "copy & send", pin and opacity; opens tasks in the main window.
- Appearance settings: theme (dark, light, system), accent colour, density, text size and glass strength, shared live between windows.
- Glass that takes the tone of what is behind it: on macOS the main and floating windows are translucent (vibrancy) with the title bar hidden and the traffic lights in the sidebar; native materials follow the app theme. The dark palette is a warm neutral grey instead of black.
- `update-macos.command`: double-click updater that pulls from GitHub (fast-forward only, refuses local changes) and reinstalls only when there is something new.
- README rewritten with animated demos, theme-aware screenshots, Mermaid diagrams, install and update guides and the plan for automatic updates; Turkish README (`README.tr.md`).
- The UI follows the project's `settings.language` until a language is picked with the toggle; the desktop menu follows the system language (English or Turkish).
