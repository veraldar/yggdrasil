#!/usr/bin/env bash
# C8: the trunk's pages wear the live app look. Copy the app's tokens, brand finish and Commit Mono
# into assets/ (embedded with include_bytes!; there is no Node on the VPS). Run after the app's
# styles change; `cargo test shell_assets_match_the_app` fails until you do.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
app="$here/../../../../branch"
cp "$app/styles/tokens.css" "$here/assets/tokens.css"
cp "$app/styles/brand.css" "$here/assets/brand.css"
cp "$app/fonts/CommitMono-400-Regular.otf" "$here/assets/CommitMono-400-Regular.otf"
cp "$app/fonts/CommitMono-700-Regular.otf" "$here/assets/CommitMono-700-Regular.otf"
echo "shell assets synced from $app"
