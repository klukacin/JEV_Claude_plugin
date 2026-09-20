# Jev plugin for Claude Code — design spec

Date: 2026-09-19
Status: draft for review
Plugin root: `/Users/martin/projects/Jev` (this repository)

## 1. Goal

Give Claude Code a fast, cheap "System One" decision layer backed by TypeSafe AI's
Jev model, so that:

1. Delegated subagent work is routed to the cheapest model tier that can do it well.
2. Every user request gets a fast triage (kind, complexity, browser/web need, risk)
   that Claude sees as advisory context.
3. Shell commands are risk-screened before they run, adding a permission prompt
   for dangerous ones without ever granting permission on Jev's say-so.
4. Claude can call Jev directly for ad-hoc typed judgments (choose, score,
   yes/no, batch over many items, pick a model tier).

Everything ships as one Claude Code plugin named `jev`, installed in place from a
local marketplace so edits take effect immediately.

## 2. Background facts the design relies on

TypeSafe API (verified against docs.typesafe.ai on 2026-09-19):

- `POST https://api.typesafe.ai/v1/systemone`, header `Authorization: Bearer <key>`,
  JSON body `{ model, state, questions }`. `GET /v1/models` lists models.
- Model alias `jev-latest` (currently `jev-1.13.0`). Aliases: `jev-preview`.
- `state`: string, JSON object, or array of text. Text only, English best.
  Limit: 64k tokens per request, 32k for state plus the longest question.
- Question types and answers:
  - `choice`: `criteria` = map option → description (≤ 255). Answer: `choice`,
    `probabilities` (sum 1), `confidence` (0–1, from distribution shape).
  - `score`: `criteria` = ordered array of 2–10 level descriptions. Answer: `score`
    (probability-weighted position 0..N-1, continuous), `legend`, `probabilities`,
    `confidence`.
  - `noul`: optional `criteria: { true, false }`. Answer: `noul` = probability of
    yes. No separate confidence.
- All questions in one request run in parallel; adding questions adds no latency.
- Errors: 401 invalid key, 422 validation, 429 rate limit, 529 overloaded.
  Retry with backoff on 429/529/5xx.
- Documented weaknesses (jev-1.13 jaggedness): literal reading, arithmetic, dates,
  indirection/double negatives, irrelevant detail, adversarial content, contradictory
  instructions. Consequence: questions state the exact condition, state carries only
  what the question needs, and code owns thresholds and identities.

Claude Code (verified against code.claude.com/docs on 2026-09-19; desktop app
bundles Claude Code 2.1.275, CLI on PATH is 2.1.234):

- Plugin layout: `.claude-plugin/plugin.json`, `hooks/hooks.json`, `.mcp.json`,
  `skills/<name>/SKILL.md`. `${CLAUDE_PLUGIN_ROOT}` resolves to the plugin
  directory; `${CLAUDE_PLUGIN_DATA}` is a persistent per-plugin data directory.
- A directory-source plugin installed from a local marketplace is loaded in place
  (not copied); edits to hooks/MCP need `/reload-plugins` or a restart, skill edits
  are picked up immediately.
- `PreToolUse` hooks match built-in tools including `Agent` and `Bash`. Output
  `hookSpecificOutput.updatedInput` replaces the entire tool input object.
  `permissionDecision: "ask"` forces a prompt even in auto mode (≥ 2.1.211);
  `"deny"` blocks. A hook that returns no output lets the call proceed unchanged.
- `UserPromptSubmit` receives `prompt`; `hookSpecificOutput.additionalContext`
  (or plain stdout) is injected as a system reminder Claude can see.
- The Agent tool accepts a per-invocation `model` (`haiku`, `sonnet`, `opus`,
  `fable`, or a full model ID); omitting it inherits the session model. This is the
  only place Claude Code lets a hook change which model runs a task.
- Plugin MCP tools are exposed as `mcp__plugin_<plugin>_<server>__<tool>`.
- Hook `command` hooks: exec form (`command` + `args`, no shell) or shell form.
  Timeouts default to 600 s (30 s on UserPromptSubmit); we set our own.

Prior art reviewed: official `typesafe-ai/skills` plugin (documentation skill only,
no runtime tools), `codaaiteam/jev-mcp` (Node MCP server, 5 tools, no hooks),
`racecraft-lab/typesafe-mcp` (Go MCP server + skill, evals, no hooks), LangChain's
`ModelRouterMiddleware` / `AutoModeMiddleware` (the routing and gating ideas this
plugin brings to Claude Code).

## 3. Architecture

Three layers in one plugin, all Node ≥ 20 ESM with zero npm dependencies (built-in
`fetch`, `node:test`). No install step beyond registering the plugin.

```
Jev/
├── .claude-plugin/plugin.json          # name "jev", version, metadata
├── .claude-plugin/marketplace.json     # local marketplace, source "./"
├── .mcp.json                           # server "jev" → bin/jev-mcp
├── hooks/hooks.json                    # PreToolUse(Agent), PreToolUse(Bash), UserPromptSubmit
├── hooks/run-hook.sh                   # finds node, execs hooks/<name>.mjs
├── hooks/route-agent.mjs               # subagent model router
├── hooks/triage-prompt.mjs             # request triage
├── hooks/gate-bash.mjs                 # command risk gate
├── bin/jev-mcp                         # sh launcher → server/mcp.mjs
├── server/mcp.mjs                      # tool definitions + handlers
├── lib/mcp-protocol.mjs                # minimal JSON-RPC over stdio (initialize, tools/list, tools/call, ping)
├── lib/jev-client.mjs                  # HTTP client: auth, timeout, retry, typed errors, key redaction
├── lib/config.mjs                      # env resolution, defaults, tier map, thresholds
├── lib/questions.mjs                   # question builders + pure decision policies
├── lib/gate-prefilter.mjs              # regex allowlist for provably safe commands
├── lib/hook-io.mjs                     # stdin JSON, stdout JSON, fail-open wrapper, decision log
├── skills/jev-decisions/SKILL.md       # model-invoked guidance
├── skills/status/SKILL.md              # /jev:status
├── scripts/status.mjs                  # key check, models, config, log tail
├── scripts/set-key.mjs                 # prompts for key on TTY, merges into ~/.claude/settings.json env
├── scripts/smoke.mjs                   # live end-to-end check (needs key)
├── test/*.test.mjs                     # node --test, mock backend, no network
├── evals/                              # claude plugin eval cases (phase 2)
├── docs/superpowers/specs/…            # this document
├── README.md · LICENSE (MIT) · package.json (scripts only) · .gitignore
```

Data flow:

```
user prompt ──UserPromptSubmit──▶ triage-prompt.mjs ──▶ Jev ──▶ additionalContext "[Jev triage] …"
Claude → Agent(...) ──PreToolUse──▶ route-agent.mjs ──▶ Jev ──▶ updatedInput { …, model: "haiku" }
Claude → Bash(...)  ──PreToolUse──▶ gate-bash.mjs   ──▶ (prefilter) ──▶ Jev ──▶ ask | advice | nothing
Claude → mcp__plugin_jev_jev__{decide,choose,score,check,batch,route} ──▶ server/mcp.mjs ──▶ Jev
```

Shared invariants:

- **Fail-open.** Any error, missing key, timeout, or disabled flag makes a hook exit
  0 with no output; the tool call or prompt proceeds exactly as Claude sent it.
  Jev being down never blocks work.
- **Never grant.** No hook ever returns `permissionDecision: "allow"`. The gate
  can only add `ask`/`deny`/advice on top of Claude Code's own permission system.
- **Minimal state.** Each call sends only the fields its questions need (Jev is
  distracted by irrelevant detail). Prompts are truncated to a hard character cap.
- **Code owns policy.** Jev returns probabilities; thresholds, tier maps, and
  safety bumps live in pure functions in `lib/questions.mjs` and are unit-tested.
- **Key never logged.** Errors and logs redact anything that looks like the key.

## 4. Configuration

All configuration is environment variables. Recommended location is the `env` block
of `~/.claude/settings.json`, which Claude Code applies to its own process so hooks
and the MCP server inherit it in both the CLI and the desktop app.

| Variable | Default | Meaning |
|---|---|---|
| `TYPESAFE_API_KEY` | (none) | Required for any call. `JEV_API_KEY` accepted as an alias |
| `JEV_MODEL` | `jev-latest` | Model sent in every request |
| `JEV_BASE_URL` | `https://api.typesafe.ai` | API root (gateways) |
| `JEV_HOOK_TIMEOUT_MS` | `6000` | Per-request budget inside hooks (hook process limit is 15 s) |
| `JEV_TOOL_TIMEOUT_MS` | `20000` | Per-request budget inside MCP tools |
| `JEV_ROUTER` | `1` | Subagent model router on/off |
| `JEV_ROUTER_OVERRIDE` | `0` | `1` = route even when Claude set `model` explicitly |
| `JEV_ROUTER_CUSTOM_AGENTS` | `0` | `1` = also route custom (non built-in) subagent types |
| `JEV_ROUTER_TIERS` | `{"fast":"haiku","standard":"sonnet","strong":null}` | Tier → model alias. `null` leaves `model` unset (inherit) |
| `JEV_ROUTER_MIN_CONFIDENCE` | `0.6` | Below this the router leaves the call untouched |
| `JEV_TRIAGE` | `1` | Request triage on/off |
| `JEV_GATE` | `1` | Bash gate on/off |
| `JEV_GATE_MODE` | `ask` | `ask` / `deny` / `advise` |
| `JEV_GATE_ASK_THRESHOLD` | `2.0` | Risk score (0–3) at or above which the gate asks |
| `JEV_GATE_DENY_THRESHOLD` | `2.6` | In `deny` mode, score at or above which it denies |
| `JEV_GATE_WARN_THRESHOLD` | `1.3` | Score at or above which advice is injected |
| `JEV_LOG` | `${CLAUDE_PLUGIN_DATA}/decisions.jsonl` (else `~/.claude/jev/decisions.jsonl`) | Decision log; `0` disables |
| `JEV_DEBUG` | `0` | Verbose stderr from hooks and server |

`scripts/set-key.mjs` reads the key from the terminal without echo and merges
`env.TYPESAFE_API_KEY` into `~/.claude/settings.json`, so the key never has to be
pasted into a chat transcript.

## 5. Components

### 5.1 `lib/jev-client.mjs`

- `createClient(cfg)` → `{ systemOne({ state, questions, model? }, { timeoutMs }), listModels() }`.
- Uses `fetch` with `AbortController`. Retries at most twice on 429, 529, 5xx and
  network errors, with 300 ms then 900 ms backoff, but never past `timeoutMs` total.
- Throws `JevError { code, status, message }` with `code` in
  `no_key | auth | validation | rate_limit | overloaded | timeout | network | http | bad_response`.
- Response is validated minimally: `answers` object present; each answer has `type`.
- Any occurrence of the key in error text is replaced with `***`.

### 5.2 `lib/questions.mjs` (pure)

Builders return `{ state, questions }`; policies take `answers` and config and
return decisions. All thresholds come from config.

**Router** — `buildRouter({ prompt, description, subagent_type })`

- state: `{ task: <prompt, max 12 000 chars>, summary: <description>, agent_type }`
- `tier` (choice): "Choose the least costly model tier that can complete this
  delegated task well on the first attempt."
  - `fast`: mechanical or narrowly specified work: find files or symbols, read and
    summarize known files, run a command and report output, apply a precisely
    described small edit, rename or format. Little judgment needed.
  - `standard`: ordinary engineering work needing judgment across several files:
    implement a described feature, write tests, fix a bug with a known cause,
    research a question in the codebase and recommend.
  - `strong`: hard or high-stakes work: architecture or design decisions, debugging
    with unknown cause across systems, security-sensitive or data-loss-prone changes,
    subtle concurrency or performance reasoning, work where a wrong answer is expensive.
- `stakes` (score, 3 levels): "How costly is it if this task is done slightly wrong?"
  levels: trivial (easily noticed and redone) / moderate (wastes time or needs a fix
  later) / high (could corrupt work, mislead a decision, or be hard to detect).

`decideTier(answers, cfg)` → `{ tier, model | null, reason }`:

1. If `tier.confidence < JEV_ROUTER_MIN_CONFIDENCE` → `model: null`, reason `low_confidence`.
2. If `tier === "fast"` and `stakes.score ≥ 1.5` → tier becomes `standard` (safety bump).
3. `model = JEV_ROUTER_TIERS[tier]` (`null` = leave unset).

**Triage** — `buildTriage({ prompt })`

- state: `{ user_request: <prompt, max 8 000 chars> }`
- `kind` (choice): question / small_change / feature / debugging / research / ops / other,
  each with a one-line description.
- `complexity` (score, 4 levels): trivial / routine / substantial / hard.
- `needs_live_browser` (noul): "Does completing this request require operating a
  real web browser: clicking, typing into forms, logging in, or using a
  JavaScript-rendered app? Fetching a static page or an API does not count."
- `needs_web` (noul): needs information from the internet unlikely to be in the
  project or general knowledge (recent releases, live data, third-party docs).
- `risk` (score, 3 levels): harmless / some risk / serious (data loss, production,
  secrets, other people).

`triageGuidance(answers)` → one or two short sentences, deterministic:

- complexity ≥ 2.3 → "Hard task: plan first, keep it on the main model."
- complexity ≤ 0.7 → "Routine task: act directly, no extended planning."
- needs_live_browser ≥ 0.6 → "Real browser interaction likely needed; use the browser tools."
- needs_live_browser ≤ 0.2 and needs_web ≥ 0.6 → "Prefer WebSearch/WebFetch; a browser is not needed."
- kind = research → "Delegate broad exploration to Explore subagents (fast tier)."
- risk ≥ 1.5 → "Elevated risk: confirm destructive steps with the user first."

Injected text (≤ 400 chars), for example:

```
[Jev triage] kind=debugging (p=0.78) · complexity=2.4/3 (conf 0.66) · live browser 0.06 · web info 0.81 · risk 1.1/2
Hard task: plan first, keep it on the main model. Prefer WebSearch/WebFetch; a browser is not needed.
```

Skip conditions (no call): prompt starts with `/`, prompt shorter than 15
characters, or `JEV_TRIAGE=0`.

**Gate** — `buildGate({ command, description, cwd, permission_mode })`

- state: `{ command, stated_intent: description, working_directory: basename(cwd) }`
- `risk` (score, 4 levels): "How risky is it to run this shell command automatically,
  without a human checking it first?"
  - 0 safe: read-only, builds, tests, or output that changes nothing outside a scratch area.
  - 1 low: changes project files in a way that is easy to undo with git or by re-running.
  - 2 needs review: deletes or overwrites files, rewrites git history, pushes to a
    shared remote, installs or removes software system-wide, changes configuration or
    permissions, or sends data to an external service.
  - 3 dangerous: could destroy unrecoverable data, affect production systems or other
    people, expose secrets, or damage the machine.
- `irreversible` (noul): "Would the effects of this command be hard or impossible to undo?"
- `external` (noul): "Does this command send data to, or change state on, a system
  outside this machine (remote git, cloud, database server, deployment, third-party API)?"

`decideGate(answers, cfg)` → `{ decision: "ask" | "deny" | "advise" | "none", reason }`:

- `s = risk.score`.
- mode `ask`: `s ≥ ASK` → ask; `WARN ≤ s < ASK` → advise; else none.
- mode `deny`: `s ≥ DENY` → deny; `ASK ≤ s < DENY` → ask; `WARN ≤ s < ASK` → advise.
- mode `advise`: `s ≥ WARN` → advise; else none.
- Low confidence never downgrades a risky verdict (uncertain and risky still asks).
- Reason text: `Jev risk 2.6/3 (dangerous) · irreversible 0.83 · external 0.12 · <top level description>`.

### 5.3 `lib/gate-prefilter.mjs` (pure)

`isProvablySafe(command)` returns true only when every segment of the pipeline
(split on `|`, `&&`, `;`, `||`) starts with an allowlisted read-only binary and the
command contains no file redirection other than to `/dev/null`, no command
substitution that invokes a non-allowlisted binary, and no `sudo`. Allowlist:
`ls cat head tail less wc grep rg find(without -delete/-exec) git(status|diff|log|show|branch|blame|rev-parse|remote -v|stash list) pwd which type echo printf env printenv date uname whoami id file stat du df tree jq yq sed(-n only) awk(print only) sort uniq cut tr basename dirname realpath readlink node --version npm --version npm ls npm view python3 --version pip3 list|show|index cargo --version go version bun --version claude --version`.
Anything else goes to Jev. Unit tests hold a table of safe and unsafe commands.

**Opaque-token rule and global rejects.** Every check above is a string comparison against a
token, so it is only worth anything if the token the shell sees is the token the prefilter
sees. Ordinary quoting and expansion break that: `-de'lete'`, `-del\ete`, `-{delete,print}`,
`${X:--delete}` and `$'-delete'` all reach `find` as `-delete`. The tokenizer therefore
classifies each token. A token is *plain* when it is a fully unquoted run of
`[A-Za-z0-9_./:=@,+%~^*?[\]-]`, or a single whole-token string in single quotes with no inner
quote, or in double quotes with no `"`, `$`, backtick or backslash inside; its plain value is
the unquoted text, so the flag checks keep working. Every other token is *opaque* and one
opaque token makes the whole command unsafe. Before any of that, the whole command is rejected
outright when it contains `(` or `)` (command substitution, process substitution, zsh `=(…)`
and glob qualifiers, `awk` programs with calls), a backtick, `${`, `$'`, a brace expansion
`{a,b}`, any backslash, `sudo`/`doas`, a redirect to anything but `/dev/null`/`&1`/`&2`, or a
trailing `&`. A binary is accepted only as a bare name or as an absolute path under `/bin`,
`/usr/bin`, `/usr/local/bin` or `/opt/homebrew/bin`, so `./ls`, `~/bin/ls` and
`/tmp/evil/git` cannot borrow an allowlisted name. Leading `NAME=value` assignments are an
allowlist (`LC_*`, `LANG`, `TZ`, `TERM`, `COLUMNS`, `LINES`, `NO_COLOR`, `FORCE_COLOR`, `CI`);
every other assignment is unsafe, because `RIPGREP_CONFIG_PATH=`, `HOME=`, `XDG_CONFIG_HOME=`
and `GOFLAGS=` all redirect a tool to attacker-chosen config or preload code. Per-binary rules
follow the same principle — allowlist the option forms rather than denylist them — because the
tools abbreviate and cluster options (`sort -no`, `git config --unset-a`, `npm audit --json
fix`). Over-rejecting only costs a Jev round trip.

**Blast radius of the runner allowlist.** Allowlisting `npm test`, `npm run test|build|lint|…`,
`node --test`, `npx tsc|jest|eslint|prettier|vitest`, `pytest`, `cargo test|build|check|clippy`,
`go test|build|vet` and `bun test` means the project's own test and build tooling executes
arbitrary project code without a Jev check. That is deliberate — it is code the user already
runs constantly — but the arguments are restricted so a runner cannot be turned into a file
writer or a way to execute an arbitrary path: every argument after the runner and its
subcommand must match `^[A-Za-z0-9_./:=-]+$`, must not start with `/` or `~`, must not contain
a `..` path component, and must not start with `-o`, `--out`, `--output`, `--outFile`,
`--outDir`, `--outputFile`, `--basetemp` or `--target-dir`. `go test ./...` stays safe;
`go build -o /tmp/out ./...`, `pytest --basetemp=DIR`, `npx tsc --outDir dist` and
`node --test /etc/passwd` all go to Jev.

### 5.4 Hooks

`hooks/hooks.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Agent", "hooks": [ { "type": "command", "command": "\"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.sh\" route-agent", "timeout": 15, "statusMessage": "Jev: choosing subagent model" } ] },
      { "matcher": "Bash",  "hooks": [ { "type": "command", "command": "\"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.sh\" gate-bash",   "timeout": 15, "statusMessage": "Jev: screening command" } ] }
    ],
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command", "command": "\"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.sh\" triage-prompt", "timeout": 15, "statusMessage": "Jev: triaging request" } ] }
    ]
  }
}
```

`hooks/run-hook.sh` locates `node` (PATH, then `/opt/homebrew/bin`, `/usr/local/bin`,
`~/.volta/bin`, `~/.fnm`, `~/.nvm/versions/node/*/bin`) and execs
`node "$PLUGIN_ROOT/hooks/$1.mjs"`. If no node is found it exits 0 silently
(fail-open). The desktop app's hook PATH may not include Homebrew, which is why the
shell launcher exists.

`hooks/route-agent.mjs`:

1. Read stdin JSON; require `tool_name === "Agent"`.
2. Skip (exit 0, no output) when: `JEV_ROUTER=0`; no key; `tool_input.model` is set
   and `JEV_ROUTER_OVERRIDE=0`; `subagent_type` is not a built-in (`general-purpose`,
   `Explore`, `Plan`, `claude`, or absent) and `JEV_ROUTER_CUSTOM_AGENTS=0`.
3. Call Jev with `buildRouter`; apply `decideTier`.
4. If `model` is non-null: print
   `{ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { ...tool_input, model }, additionalContext: "Jev routed this subagent to <model> (tier=<tier> p=<p>, stakes=<s>)." } }`.
   Otherwise print nothing.
5. Append a decision-log line.

`hooks/triage-prompt.mjs`:

1. Read stdin; take `prompt`; apply skip conditions.
2. Call Jev with `buildTriage`; format the `[Jev triage]` line plus guidance.
3. Print `{ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext } }`.

`hooks/gate-bash.mjs`:

1. Read stdin; require `tool_name === "Bash"`; take `tool_input.command`.
2. Skip when `JEV_GATE=0`, no key, or `isProvablySafe(command)`.
3. Call Jev with `buildGate`; apply `decideGate`.
4. `ask` → `{ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason } }`;
   `deny` → same with `"deny"`; `advise` → `{ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "[Jev gate] …" } }`; `none` → no output.

`lib/hook-io.mjs` wraps each hook: parse stdin with a 1 s read timeout, run the
handler, serialize output, and on any thrown error log to stderr (and the decision
log) and exit 0. It also enforces the per-request `JEV_HOOK_TIMEOUT_MS`.

Decision log line (JSONL): `{ ts, hook, decision, model?, score?, confidence?, latency_ms, preview }`
where `preview` is the first 120 characters of the prompt or command. `JEV_LOG=0`
turns logging off.

### 5.5 MCP server

`.mcp.json`:

```json
{ "mcpServers": { "jev": { "command": "${CLAUDE_PLUGIN_ROOT}/bin/jev-mcp", "args": [] } } }
```

`bin/jev-mcp` is a `sh` launcher using the same node-discovery as the hooks and
`exec`s `node server/mcp.mjs`. Tools appear as `mcp__plugin_jev_jev__<tool>`.

`lib/mcp-protocol.mjs` implements newline-delimited JSON-RPC 2.0 over stdio:

- `initialize` → `{ protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "jev", version }, instructions }`.
  `protocolVersion` echoes the client's if it is one of `2025-06-18`, `2025-03-26`,
  `2024-11-05`; otherwise `2025-06-18`.
- `notifications/initialized`, `notifications/cancelled` → ignored.
- `ping` → `{}`.
- `tools/list` → tool definitions (JSON Schema inputs, `annotations: { readOnlyHint: true, openWorldHint: true }`).
- `tools/call` → `{ content: [{ type: "text", text }], isError? }`.
- Unknown method → error `-32601`; malformed JSON → `-32700`; invalid params → `-32602`.
- JSON arrays (batches) are processed element by element. Stdout carries only
  protocol frames; all logging goes to stderr.

Tools (`server/mcp.mjs`):

| Tool | Input | Output |
|---|---|---|
| `decide` | `state` (string/object/array), `questions` (map id → `{type, instructions, criteria?}`), `model?` | raw `{ model, answers, usage }` |
| `choose` | `state`, `instructions`, `options` (map option → description), `model?` | `{ choice, probabilities, confidence }` |
| `score` | `state`, `instructions`, `levels` (2–10 strings), `model?` | `{ score, max, nearest_level, legend, probabilities, confidence }` |
| `check` | `state`, `instructions`, `criteria?` `{true,false}`, `model?` | `{ probability, likely }` |
| `batch` | `items` (1–200 strings/objects), `question` (`{type, instructions, criteria?}`), `shared_state?`, `concurrency?` (1–16, default 8) | `{ results: [{ index, answer | error }], summary }`; summary sorts by probability/score or counts choices |
| `route` | `task`, `context?` | `{ tier, model, confidence, stakes, probabilities }` using the same router policy as the hook |

Validation before calling Jev: non-empty questions; type in `noul|choice|score`;
`choice` needs an object with 1–255 entries; `score` needs an array of 2–10 strings.
Errors return `isError: true` with a message that names the fix (for `no_key`:
where to get a key and how to set it).

`instructions` (sent at initialize) is a two-sentence summary: Jev returns typed
answers with calibrated probabilities in ~200 ms; use it for judgments whose answer
space can be listed up front, never for generating text.

### 5.6 Skills

`skills/jev-decisions/SKILL.md` — `name: jev-decisions`, `user-invocable: false`.
Description (drives auto-invocation): typed judgments with calibrated probabilities
via the `jev` MCP tools; use when a step turns on a judgment call, when classifying,
filtering, ranking or deduplicating many items the same way, when choosing which
model tier a subtask deserves, or when a `[Jev triage]`, `[Jev gate]`, or routing note
appears in context; not for generating text or code. Body (≤ 150 lines):

- When to use / when not to (answer space must be enumerable; a user's stated
  decision stands; not for lookups).
- The six tools, one line each, with the `batch` pattern for N items.
- How to write questions: one judgment per question, exact condition in the
  instructions, options with boundaries, levels that describe concrete situations,
  keep arithmetic and dates in code, filter state first.
- Reading the numbers: `noul` near 0.5 means undecided, `score` fractions are the
  signal, low `confidence` means overlapping options or missing evidence.
- How to treat hook output: triage and gate notes are advisory; the user's explicit
  instructions always win; a routed subagent model can be overridden by passing
  `model` explicitly.
- Links to the live docs index and the primitive pages.

`skills/status/SKILL.md` — `name: status`, `disable-model-invocation: true`,
`allowed-tools: Bash(node *)`. Instructs Claude to run
`node "${CLAUDE_PLUGIN_ROOT}/scripts/status.mjs"` and report the result. The script
prints: key present (masked), `GET /v1/models` result or error, effective config,
the last 10 decision-log lines, and whether `node` is resolvable by the launcher.

### 5.7 Scripts

- `scripts/status.mjs` — as above; exit 1 on missing key or auth failure.
- `scripts/set-key.mjs` — prompts on the TTY with echo off, validates the key with
  `GET /v1/models`, merges `env.TYPESAFE_API_KEY` into `~/.claude/settings.json`
  (creating `env` if absent, preserving everything else), prints where it wrote.
- `scripts/smoke.mjs` — live check: one call per MCP tool and one run of each hook
  script with a realistic stdin payload; prints a pass/fail table. Requires a key;
  never run by `npm test`.

## 6. Installation and rollout

1. Set the key: `node scripts/set-key.mjs` (or add `env.TYPESAFE_API_KEY` to
   `~/.claude/settings.json` by hand).
2. Register and install in place:
   `claude plugin marketplace add /Users/martin/projects/Jev` then
   `claude plugin install jev@jev --scope user`.
3. Restart Claude Code (or `/reload-plugins`). Check `/jev:status` and that
   `mcp__plugin_jev_jev__decide` is listed under `/mcp`.
4. Optional: also install TypeSafe's official `typesafe` documentation plugin
   (`claude plugin marketplace add typesafe-ai/skills`, `claude plugin install typesafe@typesafe-ai`).
   It teaches Claude to write TypeSafe integration code and does not collide with
   this plugin (different skill names, no MCP server).

`marketplace.json` names the marketplace `jev` and lists one plugin `jev` with
`source: "./"`, so the repository is simultaneously the marketplace and the plugin.

## 7. Testing

`npm test` runs `node --test test/` with no network and no key. A local
`node:http` mock of `/v1/systemone` and `/v1/models` is started per test file and
pointed to via `JEV_BASE_URL`.

- `questions.test.mjs`: builders emit valid question shapes; `decideTier`,
  `triageGuidance`, and `decideGate` at every threshold edge and every mode.
- `prefilter.test.mjs`: table of safe commands (must skip) and unsafe commands
  (must call), including pipelines, redirections, `sudo`, `find -delete`.
- `client.test.mjs`: success, 401 → `auth`, 422 → `validation`, 429 then 200 →
  retried, 529 exhaustion → `overloaded`, hang → `timeout`, key redaction in errors.
- `hooks.test.mjs`: spawn each hook with stdin payloads and assert stdout JSON and
  exit 0: router sets `model` and preserves other fields; respects explicit
  `model`; skips custom agents; low confidence → no output; triage skips `/cmd`;
  gate skips safe commands, asks at ≥ 2.0, advises between 1.3 and 2.0, denies only in
  `deny` mode; every hook exits 0 with empty stdout when the key is missing or the
  backend is unreachable.
- `mcp.test.mjs`: spawn the server; `initialize` handshake; `tools/list` has six
  tools with valid schemas; each `tools/call` happy path; validation errors return
  `isError`; `batch` honors concurrency and isolates per-item failures; unknown
  method → `-32601`; batch arrays handled.
- `plugin-structure.test.mjs`: manifests parse; every path referenced in
  `hooks.json` and `.mcp.json` exists and is executable; `claude plugin validate .`
  passes when the CLI is available.

Live verification after implementation (manual, needs the key):

1. `node scripts/smoke.mjs` passes.
2. In a real session: a prompt produces a `[Jev triage]` note (visible in the
   debug log and in Claude's behavior); an `Agent` call to `Explore` for a trivial
   search runs on haiku (confirmed from the subagent transcript's `model` field); a
   command like `rm -rf node_modules dist` triggers a permission prompt whose reason
   starts with `Jev risk`; `ls -la` does not.
3. Phase 2: `claude plugin eval .` with three cases (a many-item classification that
   should use `batch`, a pick-one-approach judgment that should use `choose` or
   `score`, and a no-trigger typo fix). Not required for the first release.

## 8. Privacy and security

- What leaves the machine: subagent prompts and descriptions (router), user prompts
  (triage), shell commands with Claude's stated intent and the working-directory
  name (gate), and whatever Claude passes to the MCP tools. File contents are sent
  only if they are inside those texts. Each channel has an off switch.
- The key is read from the environment only, never written to any plugin file,
  never logged, and redacted from error messages.
- The gate never approves anything. Jev can be misled by adversarial text inside a
  command; Claude Code's permission rules and auto-mode classifier remain the
  primary control, and the gate is an additional layer.
- Fail-open is deliberate: an outage at TypeSafe must not stall Claude Code. A
  fail-closed gate is a possible later option, not part of this design.

## 9. Non-goals

- No OpenRouter or other backends; no Python; no npm publishing.
- No automatic change of the main session's model or effort. Triage is advice; the
  user (or Claude, when the user asks) changes effort or model.
- No custom subagents, no Codex or other harness support, no cost dashboards.
- No fine-tuned thresholds. Defaults are starting points; the decision log exists
  so they can be tuned from real sessions.

## 10. Open items to confirm during implementation

- ~~That `updatedInput` on the `Agent` tool is applied without a `permissionDecision`
  field.~~ **Resolved.** The hook documentation states that `updatedInput` replaces the
  whole tool input on its own, with no `permissionDecision` needed, and that permission
  rules are re-evaluated against the replacement. The router therefore never emits
  `permissionDecision`, and no hook in this plugin can print `"allow"`. The live check
  still has to confirm the subagent transcript's `model`, which is the only way to see
  that the replacement actually took effect end to end.
- The exact set of built-in subagent type names in the installed version
  (`general-purpose`, `Explore`, `Plan`, `claude`); anything else is treated as custom.
