# jev — TypeSafe Jev decisions for Claude Code

## FAILED AFTER RESEARCH AND TESTING.

The author used this plugin daily for six days (2026-09-20 to 2026-09-26), measured it, compared it
with how others use Jev, and disabled it on 2026-09-26. The hooks cost more time than they saved and
caught nothing that Claude Code's own mechanisms would have missed. The code works, the tests pass, and
the full report is in [docs/findings.md](docs/findings.md).

**Test results (real use, 0.1.0, about 18,000 logged decisions):**

| Part | Result | Verdict |
|---|---|---|
| Bash risk gate | About 12,000 commands sent to Jev, **126 min of added latency**; no case found where it prevented damage. In auto mode, Claude Code's own classifier already reviews risky actions. | failed |
| Prompt triage | 419 prompts, most of them harness messages; generic advice with no measurable effect | failed |
| MCP tools | never called by Claude unprompted | failed |
| Subagent router | 22 of 125 subagents re-routed; **about $70–110 saved in six days** (10–13% of their cost at API list prices), but only by moving high-stakes work from Opus to Sonnet. Keeping high-stakes work on Opus leaves about $2–4. | small win, with a quality trade-off |

**Replays of 0.2.0 on the same data:**
- **Narrower gate:** still sends 48% of scored commands to Jev.
- **Adversarial reviews:** each of the three review rounds found new bypasses of the text-pattern layer.
- **Claim check:** zero nudges over 59 subagent runs that edited code, because every one had already run its tests.

**Unit tests:** 145/145 pass (`npm test`), and `claude plugin validate` passes.

**How others use Jev (web research):**
- TypeSafe's own Claude Code skill helps build Jev workflows *into applications* and does not supervise Claude Code.
- An independent 150-row test found Jev as accurate as Claude Haiku 4.5 (66% each), somewhat faster, and far more willing to say "unsure".
- Jev looks better suited to high-volume classification inside apps than to guarding a coding agent.

---

A Claude Code plugin that gives Claude a fast, cheap "System One" decision layer backed by
[TypeSafe AI's Jev](https://typesafe.ai). Jev does not generate text; it returns typed answers
(one option, a position on a scale, or a yes/no probability) with calibrated confidence in
about 200 ms, at a fraction of a cent per call.

What the plugin does:

- **Subagent model router** — when Claude delegates work with the Agent tool, Jev classifies the
  task and the hook rewrites the call to `haiku` (mechanical work) or `sonnet` (ordinary work).
  Hard work, and any task Jev rates as high stakes (≥ 1.5 of 2), stays on the session model.
  Explicit `model` choices are never overridden by default (`JEV_ROUTER_OVERRIDE=1` changes that).
- **Request triage** — every prompt you type gets a one-line `[Jev triage]` note (kind, complexity,
  whether a live browser or web information is needed, risk) plus short guidance. Advisory only.
  System messages such as background-agent notifications are skipped.
- **Bash risk gate** — commands that are not provably read-only *and* carry a risk signal (process
  kills, deletes, database clients and URLs, SQL writes, local scripts, git history changes, remote
  access, cloud CLIs, system configuration, secrets) are scored 0–3 by Jev. Scores of 2.6 and above
  force a permission prompt whose reason starts with `Jev risk`; everything else passes silently.
  The gate never approves anything on its own.
- **Claim check at the end of a turn** — when Claude or a subagent edited project code, ran no test,
  build, database apply, or browser check afterwards, and its final report still says the work is
  verified, a `[Jev verify]` note asks it to run the checks and report the real result. One nudge per
  stop, never a block.
- **MCP tools** `mcp__plugin_jev_jev__{decide,choose,score,check,batch,route}` for ad-hoc typed
  judgments, including `batch` for classifying or ranking up to 200 items in one call.
- **Skills** `jev-decisions` (when and how to use the tools; how to read hook notes) and `/jev:status`.

Zero npm dependencies; Node ≥ 20. Source: https://github.com/klukacin/JEV_Claude_plugin

## Install

1. Get a key at https://console.typesafe.ai/keys and store it (typed in your terminal, hidden):

   ```bash
   node scripts/set-key.mjs
   ```

   This writes `env.TYPESAFE_API_KEY` into `~/.claude/settings.json`, which Claude Code passes to
   hooks and MCP servers in both the CLI and the desktop app. (Alternatively export
   `TYPESAFE_API_KEY` in your shell.)

2. Register the marketplace and install the plugin (Claude Code copies it into its cache):

   ```bash
   claude plugin marketplace add klukacin/JEV_Claude_plugin
   claude plugin install jev@jev --scope user
   ```

   Working from a local clone instead? Point the marketplace at the checkout:
   `claude plugin marketplace add /path/to/JEV_Claude_plugin`. The marketplace and the plugin
   are both named `jev`, so register only one source at a time.

3. Restart Claude Code (or run `/reload-plugins`), then check `/jev:status` and that
   `/mcp` lists the `jev` server.

   **Updating the plugin:** To refresh your installed copy after making edits here, bump
   `version` in both `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`
   (keep them equal), then run `claude plugin update jev@jev` (restart Claude Code to apply).
   Alternatively, `claude plugin uninstall jev@jev && claude plugin install jev@jev --scope user`.

Optional: TypeSafe's own documentation plugin teaches Claude to write TypeSafe integration code and
coexists with this one: `claude plugin marketplace add typesafe-ai/skills && claude plugin install typesafe@typesafe-ai`.

## Configuration

All settings are environment variables (put them in the `env` block of `~/.claude/settings.json`).

| Variable | Default | Meaning |
|---|---|---|
| `TYPESAFE_API_KEY` | — | Required. `JEV_API_KEY` is accepted as an alias |
| `JEV_MODEL` | `jev-latest` | Model for every request |
| `JEV_BASE_URL` | `https://api.typesafe.ai` | API root |
| `JEV_ROUTER` | `1` | Subagent model router |
| `JEV_ROUTER_OVERRIDE` | `0` | `1` routes even when Claude set `model` explicitly |
| `JEV_ROUTER_CUSTOM_AGENTS` | `0` | `1` also routes custom subagent types |
| `JEV_ROUTER_TIERS` | `{"fast":"haiku","standard":"sonnet","strong":null}` | Tier → model alias; `null` leaves the model unset (inherit) |
| `JEV_ROUTER_MIN_CONFIDENCE` | `0.6` | Below this the router does nothing |
| `JEV_ROUTER_MAX_STAKES` | `1.5` | Tasks rated at or above this stakes score (0–2) keep the session model |
| `JEV_TRIAGE` | `1` | Request triage |
| `JEV_GATE` | `1` | Bash gate |
| `JEV_GATE_SIGNALS` | `1` | Only commands with a risk signal go to Jev; `0` sends every non-read-only command |
| `JEV_GATE_MODE` | `ask` | `ask`, `deny`, or `advise` (never prompts; notes from the warn threshold, else the ask threshold) |
| `JEV_GATE_ASK_THRESHOLD` / `JEV_GATE_DENY_THRESHOLD` | `2.6` / `2.8` | Risk score (0–3) thresholds; deny applies only in `deny` mode |
| `JEV_GATE_WARN_THRESHOLD` | off | Set a number (e.g. `1.3`) to get `[Jev gate]` advisory notes below the ask threshold |
| `JEV_VERIFY` | `1` | Claim check on Stop and SubagentStop |
| `JEV_VERIFY_THRESHOLD` | `0.7` | How strongly the report must claim verification before the nudge |
| `JEV_HOOK_TIMEOUT_MS` / `JEV_TOOL_TIMEOUT_MS` | `6000` / `20000` | Per-request budgets |
| `JEV_LOG` | `<plugin data dir>/decisions.jsonl` | Decision log; `0` disables |
| `JEV_DEBUG` | `0` | Verbose stderr |

## How it behaves

- Every hook is fail-open: if Jev is slow, down, or unconfigured, the tool call or prompt
  proceeds exactly as Claude sent it. Nothing here can approve a command; hooks only add
  `ask`/`deny`/advice on top of Claude Code's own permission system.
- What leaves the machine: subagent prompts (router), your prompts (triage), shell commands with
  Claude's stated intent and the working-directory name (gate), the last 4,000 characters of a final
  report when the claim check runs, and whatever Claude passes to the tools. Each channel has an off switch above. The key is never logged or written to plugin files.
- Jev can be misled by adversarial text inside a command or prompt; treat the gate as an extra
  layer, not the only one.

## Development

```bash
npm test          # offline unit + integration tests against a mock TypeSafe backend
npm run smoke     # live checks against api.typesafe.ai (needs the key; costs cents)
npm run status    # same report as /jev:status
```

**GitHub install vs. local checkout.** The marketplace and the plugin are both named `jev`, so
only one source can be registered at a time. Switch to a local checkout for development:

```bash
claude plugin marketplace remove jev
claude plugin marketplace add /path/to/JEV_Claude_plugin
claude plugin install jev@jev --scope user
```

Switch back to GitHub the same way with `claude plugin marketplace add klukacin/JEV_Claude_plugin`.
Either way Claude Code copies the plugin into `~/.claude/plugins/cache/jev/jev/<version>/`, so after
editing bump `version` in both manifests and run `claude plugin update jev@jev`, then restart.

Decisions are logged as JSON lines — `${CLAUDE_PLUGIN_DATA}/decisions.jsonl` (a per-plugin
directory under `~/.claude/plugins/data/`, named after the sanitised `plugin@marketplace` id)
when installed, `~/.claude/jev/decisions.jsonl` otherwise; use them to tune thresholds. The key
is redacted out of every logged field.

## Troubleshooting

- `/jev:status` says the key is missing inside Claude Code but `npm run status` works in a
  terminal: the desktop app does not read your shell profile. Use `node scripts/set-key.mjs`.
- Hooks never fire: run `claude --debug` and look for `route-agent`, `gate-bash`, `triage-prompt`
  in the hook log; make sure `node` is on PATH or in one of the locations `lib/find-node.sh` probes.
- Too many permission prompts from the gate: raise `JEV_GATE_ASK_THRESHOLD` (e.g. `2.4`) or set
  `JEV_GATE_MODE=advise`.
- Subagents routed to haiku do poorly on some task: pass `model` explicitly in that Agent call, or
  raise `JEV_ROUTER_MIN_CONFIDENCE`.

## License

MIT
