# What we learned running jev (September 2026)

**Verdict: FAILED AFTER RESEARCH AND TESTING. The author disabled the plugin on 2026-09-26.** The code stays here, working and tested,
together with the measurements below, for anyone who wants to reuse parts of it or repeat the experiment.

## In short

- In six days of daily use, the automatic hooks cost more time than they saved and caught nothing
  that Claude Code's own mechanisms would have missed.
- Only the subagent router saved money: about **$70–110 over six days** at API list prices, 10–13% of
  what the routed agents would have cost on Opus. It saved that much only while it also sent high-stakes
  implementation work to Sonnet.
- Jev itself is cheap (a dollar or so for all our calls) and fast. The problem is where we used it.
  Claude Code already chooses models and guards commands well, while Jev looks better suited to
  high-volume classification inside applications, where "I am not sure" can be routed to a person.

## What we built

- **0.1.0 (2026-09-20):**
  - subagent model router (PreToolUse on Agent);
  - prompt triage (UserPromptSubmit);
  - Bash risk gate (PreToolUse on Bash, with a read-only prefilter);
  - MCP tools for ad-hoc typed judgments, and two skills.
  - Installed from this repo's GitHub marketplace and used daily across three projects.
- **0.2.0 (2026-09-26), built after the first measurements:**
  - the gate scores only commands with a risk signal, asks at ≥ 2.6, and writes no advisory notes;
  - triage skips harness messages;
  - the router keeps the session model for tasks Jev rates as high stakes (≥ 1.5);
  - a new claim check on Stop and SubagentStop.
  - Three rounds of adversarial review; 145 tests.

## Measurements: 0.1.0 in daily use (2026-09-20 to 2026-09-26)

These come from the plugin's decision log (about 18,000 entries) and the Claude Code transcripts of
the same period.

| Hook | Activity | Cost | Benefit observed |
|---|---|---|---|
| Bash gate | 17,700 commands. The prefilter passed 5,700 as read-only; about 12,000 went to Jev (average 628 ms). | **126 min of added latency** | Ask mode prompted 13 times on the first day, then the gate ran in advise mode and never prompted (2,027 advisory notes). We found no case where it prevented damage. |
| Router | 125 Agent calls. 22 were re-routed (20 to Sonnet, 2 to Haiku); 53 had an explicit model, 37 had low confidence, 13 inherited. | under 1 min | about $70–110 saved (see below) |
| Triage | 419 prompts, most of them harness messages (background task notifications) rather than human requests | 5 min, plus about 50–100 context tokens per prompt | generic advice; no measurable effect |
| MCP tools | never called by Claude unprompted | none | none |

### Where the router's savings come from

We joined each routed call in the log to its subagent transcript and priced the real token usage.
The 22 routed subagents used about 3.0 billion cache-read tokens, 25.5 million cache-write tokens and
0.59 million output tokens. Almost all of that came from 16 long implementation agents on a private
ERP project.

On current list prices, Opus 5.5 and Sonnet 5 charge the **same for cache reads ($0.20 per million
tokens)**. The saving therefore comes only from cache writes and output:

| Router setting | Saved in six days |
|---|---|
| Route everything Jev allows (0.1.0 behaviour) | about $70 (5-minute cache) to $110 (1-hour cache) |
| Keep tasks with stakes ≥ 1.9 on the session model | about $60–95 |
| Keep tasks with stakes ≥ 1.5 on the session model (0.2.0 default) | about $2–4 |

Jev's own cost is negligible: TypeSafe lists $42 per billion input tokens.

Whether Sonnet did those high-stakes tasks as well as Opus would have is unknown: the transcripts show
only the cost. On a subscription plan the saving shows up as Opus usage limit rather than dollars.

## 0.2.0 replays on the same data

- **Gate signals:** replayed on 11,861 commands that Jev had scored.
  - 48% would still go to Jev, which saves about 60 of 117 minutes.
  - Commands Jev scored ≥ 2.6 would still be sent to it in 101 of 102 cases, and ≥ 2.0 in 765 of 766.
  - Caveat: the signal families were derived from this same data.
- **Adversarial reviews:** each of the three review rounds found new ways to slip a dangerous command
  past the signal layer, for example:
  - masking of commit messages that hid `$(...)` substitutions;
  - environment variables that run commands (`LESSOPEN=`, `GIT_EXTERNAL_DIFF=`);
  - quoted script paths;
  - shells reading a heredoc.

  All of them are fixed and covered by tests. The lesson stands, though: a text-pattern layer in front
  of a scorer is never complete. In auto mode, Claude Code's own classifier already reviews risky
  actions; during this work it held one of our own patches for review.
- **Claim check:** replayed on 152 subagent transcripts. 59 edited code, and all 59 ran tests or checks
  after the last edit, so there would have been zero nudges. In the main thread, 2 of 593 turns
  edited code, and both were verified. It is a safety net with little to catch when agents already test.

## What others do with Jev (web research, 2026-09-26)

Items marked ✓ were checked against the source; the rest come from a research pass and were not
re-verified.

- ✓ **TypeSafe's official Claude Code skill** ([typesafe-ai/skills](https://github.com/typesafe-ai/skills), about 2.2k stars):
  - an instructional skill with no hooks;
  - it teaches the agent to design Jev workflows **in your code**, for example routing support tickets
    with human review for uncertain cases;
  - it does not supervise Claude Code itself.
- ✓ **[its-panzer/jev-model-router](https://github.com/its-panzer/jev-model-router)**, a subagent model router:
  - 97 of 100 labelled cases in band, none under-routed;
  - 26.3% cheaper than always-Opus under its cost model.
  - These are labelled test cases, not real sessions. Our real sessions show 10–13%, because cache
    reads cost the same on both models.
- ✓ **[wotai-dev/typesafe-jev-tools](https://github.com/wotai-dev/typesafe-jev-tools)**, 150-row comparison with Claude Haiku 4.5:
  - the same accuracy (66.0%) and calibration (ECE 0.121 vs 0.122);
  - somewhat faster (p50 455 ms vs 631 ms);
  - Jev flags uncertainty far more often (34.7% vs 2.7%), which is useful for escalation.
- ✓ **[jevals.com](https://jevals.com)**: on yes/no questions Jev is statistically tied with the best of six LLMs at 1/28 of the price.
- **Other Claude Code plugins** repeat the same ideas (routers, gates, skill selection), mostly with a
  handful of stars:
  - [shimo4228/jev-skill-router](https://github.com/shimo4228/jev-skill-router) concludes that its router is unlikely to help a strong model.
  - [dr-dimitru/claude-jev-plugin](https://github.com/dr-dimitru/claude-jev-plugin) classifies tool output after the fact (transient, environment, code bug, permission, user error).
  - [buchmark/claude-jev](https://github.com/buchmark/claude-jev) scores review findings and ranks debugging hypotheses.
  - [shitianfang/jev-use](https://github.com/shitianfang/jev-use) returns a typed "escalate" when Jev is unsure.
- **Discussion:** the Hacker News launch thread had skeptics. Their main points were that the
  benchmarks are mostly vendor-run, that "can't hallucinate" is marketing, and that Jev overlaps with
  existing small classifiers.

## Conclusions

- **As a supervisor of Claude Code, Jev did not pay off for us.**
  - Gate: slow, and it duplicated auto mode.
  - Triage: noise.
  - MCP tools: unused.
  - Claim check: nothing to catch.
- **Only the router saved money,** and only by trading quality risk on high-stakes work.
- **Jev looks more promising inside applications:** high-volume classification such as transaction
  categories, payment-to-invoice matching or document types, where it matches small LLMs at a fraction
  of the price and says when a person should decide.

If you run this plugin anyway, a lean setup that keeps the only measured benefit is:

```bash
JEV_GATE=0
JEV_TRIAGE=0
JEV_ROUTER_MAX_STAKES=1.9
```

The first two variables turn off the gate and triage; the third lets the router send more work to
Sonnet. The claim check stays on.

## Process lessons

- **Measure before tuning.** The first effectiveness check contradicted most design assumptions, and
  measuring real token usage reversed our view of the router.
- **Never pass test inputs for a command gate through a shell.** In one review a heredoc delimiter
  collision made zsh execute the test commands. Nothing destructive happened, which we verified
  afterwards. Write the inputs as JSON and pass them to the functions as data.
