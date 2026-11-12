# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

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
- The UI follows the project's `settings.language` until a language is picked with the toggle; the desktop menu follows the system language (English or Turkish).
