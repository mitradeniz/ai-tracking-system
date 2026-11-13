#!/bin/bash
# AI Tracking System — disk image (.dmg) for this Mac.
#
# Double-click this file in Finder. It builds the app the same way as install-macos.command, puts
# it in a .dmg under release/ and opens it: drag the app onto Applications. Needs Node.js 22.12 or
# newer. The app is signed ad hoc on this Mac, so the image is meant for this computer.
cd "$(dirname "$0")" || exit 1
AITRACK_TARGET=dmg exec ./install-macos.command
