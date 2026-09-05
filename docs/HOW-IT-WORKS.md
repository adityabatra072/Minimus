# How the Minimus harness works, in plain language

Minimus is a small language model (2.6 billion parameters by default) running
on your phone's GPU, wrapped in a loop that lets it use tools. The model is not
very smart on its own. The harness around it is what makes it useful: it
decides what the model gets to see and do, catches the ways small models fail,
and does the boring deterministic work (clock arithmetic, storage, replaying
taught phrases, memory lookup) so the model only has to make the one decision
it is good at: which tool to call next.

This document walks through one request from the moment you press send.

## 0. Reflexes: some requests never reach the model

"Turn on the flashlight", "5 minute timer", "set brightness to 40%", "what's
my battery", or a phrase you taught ("wind down") said on its own, are
recognised by `reflex.ts` and executed directly, in about 100 ms. The bar is
deliberately high: the whole sentence has to match one of a few anchored
patterns with every argument literal in the sentence. Anything with a clause,
a condition, a time, a person or a judgment goes to the model. A false
positive would do the wrong thing instantly; a false negative costs a second.

## 1. The router: which abilities does this message need?

Before the main pass, the model is asked a much smaller question in a
dedicated engine lane (a second llama.cpp context on the same weights, so its
cached prompt is never disturbed by the main one): given this message, which
of nine categories does it need — none, phone, calendar, memory, later, teach,
web, messages, music. The output is constrained by a grammar to those words
only, so it cannot ramble, and it costs about 250 ms on an iPhone 15 once the
router prompt is cached.

"none" is a first-class answer. It means conversation or general knowledge:
the main pass runs with every tool refused, thinking closed, and answers in a
second. That is what stops "hello" from running a taught phrase or reading the
battery, which the model happily did when every tool was runnable.

The router is allowed to be wrong in two ways, and both are caught:

- It says "none" for a sentence with an action verb, or a question that
  needs live data (weather, news, prices). The verdict is overruled and the
  full tool set (or the web tools) is runnable.
- It says "none" and the model still reaches for a read-only tool (recall,
  calendar, device info, search). The model's judgment wins once; reading
  something is harmless. Action tools stay refused, which is the guard that
  matters.

## 2. Composing the run

`composeRun` (`packages/agent-core/src/routing.ts`) then decides:

- **What the model sees.** Every tool, always, minus the ones you switched off
  in Tools. The tool list never changes shape per request, and that is a
  performance decision: the engine caches the processed state of the system
  prompt, and on a hybrid model like LFM2.5 that cache is wiped the moment a
  prompt with a different system section arrives. One constant prompt per
  session means the ~1500 tokens of tool descriptions are processed once, at
  load time, and every request only pays for the message itself.
- **What may run.** The router's categories become an execution allowlist.
  Deterministic guards add per-tool refusals with a reason the model can act
  on: "put it in the calendar" refuses `schedule_task` ("that is
  calendar_create"); "in 3 minutes check again" refuses the timer and alarm
  ("they only ring; hand it to schedule_task"); while you are teaching a
  phrase only `define_macro` may run; a question about a taught phrase
  refuses `run_macro` and `define_macro`.
- **Steering lines** for this message only: the clock, the fact that a
  taught phrase was mentioned (with its steps, so a question about it is
  answered from context), remembered facts that match the message (the app
  runs the same fuzzy match the recall tool would, so "what's my locker code"
  is answered without a tool call), the teaching or deferral instructions,
  and for deferrals the exact minute offset ("tonight at 9" is "+361").
- **Whether to deliberate.** Teaching, deferral, calendar placement and
  multi-part sentences are flagged as needing judgment.

## 3. The prompt the model reads

Three turns:

1. The stable system prompt: one persona line, the tool list (one line per
   tool with a one-line hint under the ones small models confuse), the rules.
   Byte-identical for the whole session.
2. A short second system turn with the clock and the steering lines above.
   It is its own turn so the model does not mistake steering for your words
   (when it sat inside the user turn, a taught phrase once got named
   "Current date/time: 2026-09-05…").
3. Your message.

The transcript is rendered in the model's own chat format by the harness
rather than the model's bundled template, because that template forces
thinking on for every turn and mis-renders multi-turn tool history.

## 4. Generation

The engine is llama.cpp via llama.rn, running on Metal. Two knobs matter:

- **Thinking.** LFM2.5-2.6B always opens a `<think>` block. The harness
  decides per turn whether to let it think: open for decisions, closed after
  an action tool succeeded (the confirmation sentence needs no deliberation)
  and for conversation. When it thinks, the sampler force-closes the block at
  a budget; when the phone reports thermal pressure the budget shrinks,
  because long deliberation is what generates the heat.
- **Prefix cache.** Each turn re-sends the whole conversation. Because the
  new prompt starts with the old one, the engine only processes the new tail.
  LFM2.5's recurrent state cannot be rewound, so the engine snapshots it at
  message boundaries and restores the newest snapshot that still matches.

Measured on an iPhone 15: prefill 250 tokens/s, decode 24 to 27 tokens/s
when cool; a greeting completes in about a second, a single tool command in
two to four, and the phone throttles to a quarter of that after a few minutes
of sustained load.

## 5. Reading the answer

`parseAssistantOutput` splits the raw text into reasoning, visible text and
tool calls. Calls come in two dialects, JSON in `<tool_call>` tags and
Python-style `[name(arg='value')]` lists, with or without wrapper tokens. The
parser repairs common slips: Python `True`/`False`/`None`, a list missing its
closing bracket, `name{"json": ...}` mixed syntax, a call nested inside the
rules' `tool_name(...)` placeholder. A bare bracketed call is only promoted
when it names a tool the model was shown.

## 6. Deciding what to do with it

- **Plain text, no call.** The run ends. An empty answer gets one nudge. A
  fast (closed-think) first turn that narrates the action instead of doing
  it gets thinking reopened and one nudge.
- **A cut-off call.** Asked for again, whole, without thinking.
- **Only thinking.** Asked to decide now, with room freed first.
- **A tool call.** Validated against the tool's schema (unknown parameters
  are rejected with the stray name, which sends a wrong-tool call to the right
  tool), refused if a guard says so, approved by you if it sends on your
  behalf, then run. Repeats of an identical call are answered from cache; a
  tool called three times in a run is switched off for the rest of it.

## 7. The tools do the hard part

- `calendar_query` returns the day's events and the free gaps as plain
  windows, so the model never does clock arithmetic.
- `schedule_task` takes "+N" minutes, refuses the past, and schedules a
  notification at the due time so a task that comes due while the app is
  closed still reaches you.
- `remember`/`recall` are a plain fact store; matching facts are also
  injected before the model runs.
- `define_macro`/`run_macro` record and replay phrases deterministically;
  replay refuses steps that would need your approval.
- `send_sms`/`make_call`/`send_email` resolve a name through Contacts.
- `create_reminder` writes to the Reminders app; `clipboard_read/write`,
  `open_url` and `find_contact` round out the phone tools.
- `describe_image` runs a separate small vision model on an attached photo.

## 8. Where to look

| Question | File |
|---|---|
| Which tools may run, which are refused, what the model is told | `packages/agent-core/src/routing.ts` |
| The router | `packages/agent-core/src/router.ts` |
| Reflexes | `packages/agent-core/src/reflex.ts` |
| Prompt layout and the cache argument | `packages/agent-core/src/prompts.ts`, `chatml.ts` |
| Per-turn thinking, retries, refusals | `packages/agent-core/src/loop.ts` |
| Engine, lanes, warm-up, thermal budget | `apps/mobile/src/services/engine.ts`, `LocalAdapter.ts`, `stores/modelStore.ts` |
| Driving the phone from a laptop | `scripts/qa/qa.mjs`, `scripts/qa/seq.sh` |
