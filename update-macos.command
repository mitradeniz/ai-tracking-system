#!/bin/bash
# AI Tracking System — macOS updater.
#
# Double-click this file in Finder. It pulls the latest version from GitHub and runs the installer
# again, which rebuilds the app and replaces the one in Applications. Your projects and task status
# are kept (they live in ~/.aitrack and in your own repositories).
#
# The app's "Update" button runs it unattended (AITRACK_UNATTENDED=1): no prompts, progress in
# ~/.aitrack/update-status.json, output in ~/.aitrack/update.log. The installer quits the app,
# replaces it and opens the new version.

set -euo pipefail
cd "$(dirname "$0")"

DATA_DIR="$HOME/.aitrack"
STATUS_FILE="$DATA_DIR/update-status.json"

status() {
  mkdir -p "$DATA_DIR"
  local msg="${2//\\/\\\\}"
  msg="${msg//\"/\\\"}"
  printf '{"state":"%s","message":"%s","at":"%s","from":"%s","to":"%s"}\n' \
    "$1" "$msg" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${AITRACK_FROM:-}" "${AITRACK_TO:-}" >"$STATUS_FILE"
}
bold() {
  printf '\n\033[1m%s\033[0m\n' "$1"
  status running "$1"
}
finish() {
  printf '\n%s\n' "$1"
  [ "${AITRACK_UNATTENDED:-}" = "1" ] || read -r -p "Press Return to close this window. " _ || true
}
fail() {
  printf '\n\033[31m%s\033[0m\n' "$1" >&2
  status failed "$1"
  finish ""
  exit 1
}

command -v git >/dev/null 2>&1 || fail "git was not found. Install the Xcode Command Line Tools (xcode-select --install) and try again."
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail "This folder is not a git clone. Download the latest version from GitHub instead."

# npm may rewrite package-lock.json on some machines; the installer uses the committed lockfile.
changed="$(git status --porcelain --untracked-files=no)"
if [ "$changed" = " M package-lock.json" ]; then
  git checkout -- package-lock.json
  changed=""
fi
[ -z "$changed" ] || fail "There are local changes in this folder (see: git status). Commit or stash them, then run the updater again."

git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1 ||
  fail "This branch does not follow a branch on GitHub. Switch to main (git switch main) and run the updater again."

bold "Checking for updates"
before="$(git rev-parse HEAD)"
git pull --ff-only || fail "Could not update automatically (the branch has diverged). Run 'git pull' in Terminal to resolve it."
after="$(git rev-parse HEAD)"

if [ "$before" = "$after" ]; then
  status current "Already up to date"
  finish "AI Tracking System is already up to date."
  exit 0
fi

export AITRACK_FROM AITRACK_TO
AITRACK_FROM="$(git rev-parse --short "$before")"
AITRACK_TO="$(git rev-parse --short "$after")"
bold "Updated $AITRACK_FROM → $AITRACK_TO"
git --no-pager log --oneline "$before..$after" | head -20
exec "./install-macos.command"
