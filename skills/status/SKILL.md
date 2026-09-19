---
name: status
description: Check the Jev plugin: API key, reachable models, router/triage/gate settings, and recent decisions.
disable-model-invocation: true
allowed-tools: Bash(node *)
---

Run this command and show the user its output as-is, then add one line saying what to fix if it reports a problem:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/status.mjs"
```

If the key is missing, tell the user to run `node "${CLAUDE_PLUGIN_ROOT}/scripts/set-key.mjs"` in their own terminal (the key is typed there, never pasted into the chat) and then restart Claude Code. Do not ask the user to paste the key into the conversation.
