#!/usr/bin/env bash
# model-step-check.sh — the Windows installer's provider table (win/veraldar.nsi, !define P_…) is the SAME as
# root/install/model-step.sh's: labels, addresses, kinds, models (the default first), the order of the list, and
# the words both show. Run by win/launcher-test.sh and by hand; exit 0 = in step.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); REPO=$(cd "$HERE/.." && pwd)
NSI=$HERE/veraldar.nsi
# shellcheck source=root/install/model-step.sh
. "$REPO/root/install/model-step.sh"
def() { sed -n "s/^!define P_$1[[:space:]]\{1,\}\"\(.*\)\"[[:space:]]*\$/\1/p" "$NSI" | tr -d '\r' | head -1; }
fails=0
same() { if [ "$2" = "$3" ]; then printf '  PASS  %s\n' "$1"; else printf '  FAIL  %s: nsi "%s" · model-step.sh "%s"\n' "$1" "$2" "$3"; fails=$((fails + 1)); fi; }
for p in $MODEL_PROVIDERS; do
  model_preset "$p"; up=$(printf '%s' "$p" | tr '[:lower:]' '[:upper:]')
  same "$p: label" "$(def "${up}_LABEL")" "$P_LABEL"
  [ "$p" = other ] && continue
  same "$p: address" "$(def "${up}_URL")" "$P_URL"
  same "$p: kind" "$(def "${up}_STYLE")" "$P_STYLE"
  same "$p: models, the default first" "$(def "${up}_MODELS")" "${P_MODELS:-$P_MODEL}"
done
same "the joining default's words" "$(def SAME_LABEL)" "$(model_step join </dev/null 2>/dev/null | sed -n 's/^  1  //p')"
# the order of the list on the page = the order of the terminal menu
page=$(tr -d '\r' <"$NSI" | sed -n 's/^  \${NSD_CB_AddString} \$hProv "\${P_\([A-Z]*\)_LABEL}"$/\1/p' | tr '[:upper:]' '[:lower:]' | tr '\n' ' ')
same "the order of the list" "${page% }" "same $MODEL_PROVIDERS"
for w in '"Model provider"' '"Address"' '"Kind"' '"Model"' '"Key"' 'API key"' '"Empty for a model on your own network."'; do
  if tr -d '\r' <"$NSI" | grep -qF "$w"; then printf '  PASS  the page says %s\n' "$w"; else printf '  FAIL  the page does not say %s\n' "$w"; fails=$((fails + 1)); fi
done
[ "$fails" = 0 ] && echo "in step" || { echo "$fails differ"; exit 1; }
