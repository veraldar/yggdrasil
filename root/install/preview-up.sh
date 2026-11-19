#!/usr/bin/env bash
# This copy stopped the :8447 brain and died with it (11-19 20:26). The one restart script is the
# live tree's — safe from inside the brain, backs up and drains first:
exec "$HOME/Work/tree-next/scripts/preview-up.sh" "$@"
