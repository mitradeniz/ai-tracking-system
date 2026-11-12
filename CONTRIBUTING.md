# Contributing

Thanks for helping. Issues and pull requests are welcome.

## Setup

```bash
npm install
npm test            # unit and API tests
npm run typecheck   # all packages
npm run dev:web     # tracker with reload + Vite dev server for the UI
npm run desktop     # build and start the desktop app
```

Node.js 22.12 or newer (see `.nvmrc`).

## Layout

- `packages/core` — file format, DAG, board, prompt rendering. Pure functions, no I/O. Most logic lives here and is unit-tested.
- `packages/server` — local tracker: registry, event log, inbox watcher, HTTP API and SSE.
- `packages/ui` — React UI. Strings live in `src/i18n.ts` (English and Turkish; add both).
- `packages/reporter` — the `aitrack-report` CLI. Keep it dependency-free.
- `apps/desktop` — Electron shell. Keep the preload bridge minimal.

## Guidelines

- Keep changes small and focused; one topic per pull request.
- Add or update tests in `packages/*/test` for behaviour changes.
- Dependencies are pinned to exact versions. Add new ones only when they clearly pay for themselves.
- Changes to the `.aitrack` format: update `packages/core/src/schema.ts`, run `npm run schema`, update `docs/file-format.md`, and keep version-1 files readable.
- Security-sensitive code (HTTP checks, IPC, file writes) needs a test. Report vulnerabilities privately, see [SECURITY.md](SECURITY.md).
- Do not commit secrets, personal data or private project files. Examples must be generic.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/): `feat(ui): …`, `fix(server): …`, `docs: …`.
