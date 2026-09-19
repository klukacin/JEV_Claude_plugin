#!/bin/sh
# lib/find-node.sh — sourced by launchers. find_node prints a node binary path or exits 1.
# The desktop app runs hooks with a minimal PATH, so Homebrew and version managers are probed too.
find_node() {
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.volta/bin/node" "$HOME/.bun/bin/node"; do
    if [ -x "$candidate" ]; then
      echo "$candidate"
      return 0
    fi
  done
  for dir in "$HOME"/.nvm/versions/node/*/bin "$HOME"/.local/share/fnm/node-versions/*/installation/bin "$HOME"/Library/Application\ Support/fnm/node-versions/*/installation/bin; do
    if [ -x "$dir/node" ]; then
      echo "$dir/node"
      return 0
    fi
  done
  return 1
}
