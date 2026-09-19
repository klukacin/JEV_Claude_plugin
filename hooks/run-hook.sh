#!/bin/sh
# hooks/run-hook.sh <hook-name> — runs hooks/<hook-name>.mjs with a discovered node.
# Fail-open: if node or the hook is missing, exit 0 with no output so the tool call proceeds.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/lib/find-node.sh"
NODE="$(find_node)" || exit 0
HOOK="$ROOT/hooks/$1.mjs"
[ -n "$1" ] && [ -f "$HOOK" ] || exit 0
exec "$NODE" "$HOOK"
