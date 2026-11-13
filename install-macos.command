#!/bin/bash
# AI Tracking System — macOS installer.
#
# Double-click this file in Finder. It builds the app for this Mac, puts it in Applications and
# opens it. Run it again after `git pull` to update. Needs Node.js 22.12 or newer and an internet
# connection the first time (npm packages and Electron are downloaded).
#
# The app's "Update" button runs it unattended (AITRACK_UNATTENDED=1): no prompts, progress in
# ~/.aitrack/update-status.json. Either way it records where it was installed from in
# ~/.aitrack/install.json, so the app knows which folder to update.
#
# With AITRACK_TARGET=dmg (make-dmg-macos.command) it makes a disk image under release/ instead of
# installing, and opens it: drag the app onto Applications.

set -euo pipefail
cd "$(dirname "$0")"

APP_NAME="AI Tracking System"
DATA_DIR="$HOME/.aitrack"
STATUS_FILE="$DATA_DIR/update-status.json"

# Progress for the app: {"state","message","at","from","to"}.
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
trap 'fail "Installation stopped because a step failed (see the messages above)."' ERR

[ "$(uname -s)" = "Darwin" ] || fail "This installer is for macOS. Elsewhere run: npm install && npm run dist"

# Finder may start this script with a short PATH: add the usual Node.js locations.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.volta/bin:$PATH"
if ! command -v node >/dev/null 2>&1 && [ -d "$HOME/.nvm/versions/node" ]; then
  # shellcheck disable=SC2012
  latest_nvm_node="$(ls -d "$HOME"/.nvm/versions/node/v*/bin 2>/dev/null | sort -V | tail -1 || true)"
  [ -n "$latest_nvm_node" ] && export PATH="$latest_nvm_node:$PATH"
fi

if ! command -v node >/dev/null 2>&1; then
  open "https://nodejs.org/en/download" >/dev/null 2>&1 || true
  fail "Node.js was not found. Install Node.js 22 (LTS) from the page that just opened, then double-click this file again."
fi
node_version="$(node -p 'process.versions.node')"
node_major="${node_version%%.*}"
node_rest="${node_version#*.}"
node_minor="${node_rest%%.*}"
if [ "$node_major" -lt 22 ] || { [ "$node_major" -eq 22 ] && [ "$node_minor" -lt 12 ]; }; then
  open "https://nodejs.org/en/download" >/dev/null 2>&1 || true
  fail "Node.js $node_version is too old; version 22.12 or newer is needed. Install it from the page that just opened, then double-click this file again."
fi

bold "1/4  Installing dependencies (the first run downloads Electron, about 150 MB)"
npm ci --no-audit --no-fund

bold "2/4  Building"
npm run build

bold "3/4  Packaging the app for this Mac"
rm -rf apps/desktop/release
# No Developer ID certificate: build unsigned and sign ad hoc below, which is enough to run it locally.
(cd apps/desktop && CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --config electron-builder.yml --mac --dir)
built_app="$(find apps/desktop/release -maxdepth 2 -type d -name "$APP_NAME.app" | head -1)"
[ -n "$built_app" ] || fail "The packaged app was not found under apps/desktop/release."

if [ "${AITRACK_TARGET:-app}" = "dmg" ]; then
  bold "4/4  Making the disk image"
  if ! codesign --force --deep --sign - "$built_app" >/dev/null 2>&1; then
    printf '\nWarning: ad hoc signing failed; after copying, run: codesign --force --deep --sign - "/Applications/%s.app"\n' "$APP_NAME"
  fi
  version="$(node -p 'require("./apps/desktop/package.json").version')"
  commit="$(git rev-parse --short HEAD 2>/dev/null || echo "local")"
  mkdir -p release
  dmg="$PWD/release/AI-Tracking-System-$version-$commit-$(uname -m).dmg"
  stage="$(mktemp -d)"
  ditto "$built_app" "$stage/$APP_NAME.app"
  ln -s /Applications "$stage/Applications"
  rm -f "$dmg"
  # hdiutil sometimes finds the folder busy right after copying; try once more.
  hdiutil create -volname "$APP_NAME" -srcfolder "$stage" -ov -format UDZO "$dmg" >/dev/null ||
    { sleep 2; hdiutil create -volname "$APP_NAME" -srcfolder "$stage" -ov -format UDZO "$dmg" >/dev/null; }
  rm -rf "$stage" apps/desktop/release
  # The app will be in /Applications once it is dragged there; updates are built from this clone.
  mkdir -p "$DATA_DIR"
  printf '{"repo":"%s","app":"%s","commit":"%s","installedAt":"%s"}\n' \
    "$PWD" "/Applications/$APP_NAME.app" "$commit" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$DATA_DIR/install.json"
  AITRACK_TO="${AITRACK_TO:-$commit}"
  status "done" "Disk image $commit"
  trap - ERR
  open "$dmg"
  finish "Done: $dmg
In the window that opened, drag \"$APP_NAME\" onto Applications (quit the app first if it is running), then open it from Applications or Launchpad."
  exit 0
fi

bold "4/4  Installing"
dest_dir="/Applications"
if [ ! -w "$dest_dir" ]; then
  dest_dir="$HOME/Applications"
  mkdir -p "$dest_dir"
fi
target="$dest_dir/$APP_NAME.app"
if pgrep -f "$APP_NAME.app/Contents/MacOS/" >/dev/null 2>&1; then
  osascript -e "tell application \"$APP_NAME\" to quit" >/dev/null 2>&1 || true
  sleep 2
fi
if [ -d "$target" ]; then
  rm -rf "$target"
fi
ditto "$built_app" "$target"
if ! codesign --force --deep --sign - "$target" >/dev/null 2>&1; then
  printf '\nWarning: ad hoc signing failed; if the app does not start, run: codesign --force --deep --sign - "%s"\n' "$target"
fi
xattr -dr com.apple.quarantine "$target" >/dev/null 2>&1 || true
# Register the app so .aitrack files open with it on double-click.
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$target" >/dev/null 2>&1 || true
rm -rf apps/desktop/release

commit="$(git rev-parse --short HEAD 2>/dev/null || echo "")"
mkdir -p "$DATA_DIR"
printf '{"repo":"%s","app":"%s","commit":"%s","installedAt":"%s"}\n' \
  "$PWD" "$target" "$commit" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$DATA_DIR/install.json"
AITRACK_TO="${AITRACK_TO:-$commit}"
status "done" "Installed $commit"

trap - ERR
open "$target"
finish "Done. \"$APP_NAME\" is in $dest_dir (also in Launchpad). Double-click any .aitrack file to open it in the app."
