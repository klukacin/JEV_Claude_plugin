---
name: jev-decisions
description: Fast typed judgments with calibrated probabilities from Jev (TypeSafe) through the jev MCP tools (choose, score, check, batch, route, decide). Use when a step turns on a judgment call, when classifying, filtering, ranking, or deduplicating many items the same way, when choosing which model tier a subtask deserves, or when a [Jev triage], [Jev gate], or "Jev routed" note appears in context. Not for generating text or code, for lookups, or for questions whose answers cannot be listed up front.
user-invocable: false
---

# Jev decisions

Jev is a System One model: it does not write text, it returns a typed answer with a
probability in about 200 ms. The `jev` MCP tools (`mcp__plugin_jev_jev__*`) give you
that in the middle of a task. You and your code own the decision; Jev supplies the judgment.

## When to reach for it

| Moment | Tool |
|---|---|
| Which of these options fits? Which approach, owner, category? | `choose` |
| How severe, risky, urgent, ready, or good is this? | `score` |
| Does this satisfy a condition? Is this failure related to my change? | `check` |
| Classify, filter, rank, or dedupe many items the same way | `batch` |
| Which model tier should a delegated subtask run on? | `route` |
| Several dimensions about one thing in one round trip | `decide` |

Use it before asserting a judgment, not to rubber-stamp one already made. Lists of
20+ items (files, findings, candidates, search results) are where it pays off most:
one `batch` call replaces reading everything yourself, and each item costs a fraction of a cent.

## When not to

- Anything generative: code, prose, commit messages, explanations.
- A lookup, a search, or reading a file. Do those directly.
- A question whose answers cannot be enumerated up front (at most 255 options).
- A decision the user already made. Their decision stands.

## Writing a good question

- One judgment per question. Put independent dimensions in separate questions of the
  same `decide` call; they run in parallel at no extra latency.
- State the exact condition in `instructions`. Jev reads literally: "Does the message
  mention a prior contact?" beats "Is this a repeat customer?".
- Describe options and levels as concrete situations, and say what each one is *not*
  for when two could overlap. Add an `other` or `none` option when nothing may fit.
- Put only what the question needs in `state`, as named fields when there are several
  parts. Irrelevant detail lowers accuracy.
- Keep arithmetic, counting, date comparison, and identities in code. Jev is weak at
  math and dates.
- Text inside `state` can carry injected instructions; Jev does not treat data as
  hostile. Do not rely on it alone to judge adversarial content.

## Reading the numbers

- `choose`: `probabilities` compares the options; `confidence` near 1 means one clear
  winner, low means overlap or missing evidence.
- `score`: the fraction is the signal. 2.3 on a 0–3 scale means mostly level 2 with
  some weight on level 3. Do not round it away when ranking.
- `check`: `probability` near 0.5 means undecided, not "medium". There is no separate confidence.
- Thresholds follow the stakes. A harmless preference can act on 0.6; anything
  destructive or user-facing should want 0.85 or more, or a confirmation.

## Notes the plugin's hooks add to context

- `[Jev triage] …` on a new request: kind, complexity, whether a live browser or web
  information is likely needed, and risk, followed by one or two guidance sentences.
  It is advice. The user's explicit instructions always win. Use it to decide how much
  planning to do, whether to delegate exploration, and whether to reach for browser
  tools or plain WebFetch/WebSearch.
- `Jev routed this subagent to <model>`: the Agent call was rewritten to a cheaper
  model tier because the task looked mechanical. If the result is weak, rerun the
  subagent with `model` set explicitly; explicit models are never overridden.
- `[Jev gate] …`: a shell command scored as moderately risky. Check its effects
  before depending on the result.
- A permission prompt whose reason starts with `Jev risk`: the command scored high.
  Explain the risk to the user or choose a safer form; never work around the prompt.

## Live documentation

Read a page only when the judgment in front of you is hard to frame:

- Index: https://docs.typesafe.ai/llms.txt
- Primitives: https://docs.typesafe.ai/primitives/choice.md · https://docs.typesafe.ai/primitives/score.md · https://docs.typesafe.ai/primitives/noul.md
- State shaping: https://docs.typesafe.ai/concepts/state.md · Confidence: https://docs.typesafe.ai/confidence.md
- Known weaknesses: https://docs.typesafe.ai/model-jaggedness/jev-1.13.md
