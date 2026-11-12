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
