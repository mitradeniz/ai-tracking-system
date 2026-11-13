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
- Problems in reports: `issues` with a plain-language title, details, kind and a fix prompt. Prompts ask for them in the project's language; tasks with problems get a red **!** on cards, lanes, the Needs-you panel and the floating window, and the task drawer lists them with the fix prompt ready to edit, copy or send to the chat. Failures, decisions the chat waits for and tools a CLI refused show up there too.
- Your own prompts: add instructions to a task when sending it, write to a chat's session at any time, and keep a list of saved prompts to insert.
- Run details for chats that run themselves: live elapsed time, tool calls, tokens, turns, list price and how full the session's context is (Claude Code), on lanes, cards, the task drawer and the floating window.
- Info tips (ⓘ) next to auto-dispatch, the run limit, the run settings and the new panels; the sidebar folds into a rail (⌘B).
- Dark theme on a black ground with black-and-white components; status colours unchanged. Smaller corner radii. Clearer lane headers and floating-window rows.
- Event sources `runner` and `hook`. Runs interrupted by quitting the app are marked blocked on the next start.
- In-app updates on macOS: the app checks the git clone it was installed from (`git fetch`) when it opens and every 6 hours, shows **Update available** in the sidebar and the new commits under **Settings → Updates** (also **Check for Updates…** in the app menu), and **Update and restart** runs `update-macos.command` in the background: pull (fast-forward only), rebuild, replace the app and reopen it. Progress and the last lines of output are shown live; the new version says it was updated or why it failed. Optional: install new versions by itself when no chat is running. It asks before restarting while chats are running.
- The installer records where it was installed from in `~/.aitrack/install.json`; installer and updater run unattended with `AITRACK_UNATTENDED=1` and write their progress to `~/.aitrack/update-status.json` and `~/.aitrack/update.log`.
- Escape closes dialogs and settings.
- New project wizard: folder and name (with the plan's language), the chats (suggested from the AI CLIs found on this computer), and the plan — written by Claude Code, Codex, Gemini or Copilot running read-only in the folder, by any other AI (copy the instructions, paste the answer, check it), or left empty. The plan is shown before it is saved; problems in an AI's answer can be sent back to be fixed. New projects no longer start with placeholder chats and tasks; a project may have no chats or tasks (`agents` and `tasks` default to empty lists).
- Plan editor: add, change and remove tasks (chat, other chats that can take it, what it waits for — cycles are prevented —, prompts in order, instructions, acceptance, allowed paths, estimate, milestone, tags), a prompt library, project settings (name, description, language, approval), and Plan with AI for a project without tasks. Edits keep the file's formatting. **+ Task** in the header and in every lane; **Edit** in the task drawer.
- Project list: pin to the top, reorder by dragging or from the ⋯ menu, remove from the list or (desktop) move the file to the Trash. The order and pins are kept in the registry.
- A ten-step intro on first launch, available again from Settings.
- A project whose code folder (`settings.repoPath`) does not exist yet: the chat's run settings say so and offer the folder of the project file (or a folder picker), and Send explains what to do instead of "Working folder not found".
- When a chat's CLI is not installed, its run settings show the command that installs it (Claude Code, Codex, Copilot, Gemini) with a copy button, and Send says how to install it instead of only "was not found".
- A CLI that is installed but not signed in shows as "not signed in" with the command to run, instead of a fix prompt for the chat. A run that failed before the model answered no longer leaves a session id behind, so the next Send starts a new session instead of trying to resume one that does not exist; a session the CLI cannot find is forgotten too.
- Lower CPU and GPU use when idle: nothing on the board animates unless a chat is running, the running-chat indicator is drawn without repaints and stops while the window is in the background, the floating window's live blur follows its focus, and git worktrees are looked up once a minute instead of every 30 seconds.
- The project's code folder: **Project settings → Code folder** changes where chats that run themselves work (stored relative to the project file; empty means the repository the file is in). When a plan points at a code folder that is not on this computer yet, the board says so and offers to create it as an empty git repository, choose another folder or use the plan's repository (`POST /api/projects/:key/code-folder`).
- No more whole-window flicker on macOS: opening the floating window no longer hides every window and the Dock icon for a moment, a window brought back from behind other windows keeps its page instead of drawing it again from empty, the native theme is set only when it changes, and pausing the running-chat indicator no longer restyles every element on each focus change. A request that fails for a moment or a project file caught while another program writes it keeps the board on screen instead of falling back to the welcome page.
- HTTP: `POST /api/projects/:key/tasks`, `…/tasks/:task/remove`, `…/prompts`, `…/prompts/:prompt/remove`, `…/info`, `…/plan`, `…/pin`, `POST /api/projects/order`, `POST /api/folder`, `POST /api/authoring/prompt`, `…/check`, `…/generate` (control token) with status and stop. The AI authoring instructions now live in `@aitrack/core` and are kept in sync with `docs/authoring-with-ai.md` by a test.
- README rewritten in English and Turkish for the new UI and features: what's inside, install, how updates work and troubleshooting, quick start, problems and run details, keyboard shortcuts, where data lives, roadmap; new demo recordings and an Updates screenshot.

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
