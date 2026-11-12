#!/bin/bash
# AI Tracking System — macOS installer.
#
# Double-click this file in Finder. It builds the app for this Mac, puts it in Applications and
# opens it. Run it again after `git pull` to update. Needs Node.js 22.12 or newer and an internet
# connection the first time (npm packages and Electron are downloaded).

set -euo pipefail
cd "$(dirname "$0")"

APP_NAME="AI Tracking System"

bold() { printf '\n\033[1m%s\033[0m\n' "$1"; }
finish() {
  printf '\n%s\n' "$1"
  read -r -p "Press Return to close this window. " _ || true
}
fail() {
  printf '\n\033[31m%s\033[0m\n' "$1" >&2
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

trap - ERR
open "$target"
finish "Done. \"$APP_NAME\" is in $dest_dir (also in Launchpad). Double-click any .aitrack file to open it in the app."
