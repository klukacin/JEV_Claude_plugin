#!/bin/sh
# hooks/run-hook.sh <hook-name> — runs hooks/<hook-name>.mjs with a discovered node.
# Fail-open: if node or the hook is missing, exit 0 with no output so the tool call proceeds.
# The root lookup uses shell builtins only. The desktop app can hand a hook a PATH with no
# coreutils on it, and `dirname` would then abort the script instead of failing open.
case "$0" in */*) DIR="${0%/*}" ;; *) DIR="." ;; esac
ROOT="$(cd "$DIR/.." && pwd)" || exit 0
[ -f "$ROOT/lib/find-node.sh" ] || exit 0
. "$ROOT/lib/find-node.sh"
NODE="$(find_node)" || exit 0
HOOK="$ROOT/hooks/$1.mjs"
[ -n "$1" ] && [ -f "$HOOK" ] || exit 0
exec "$NODE" "$HOOK"
