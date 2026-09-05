# Minimus v2.0

The release where the phone stops being the bottleneck.

## Inference: 15 to 45 seconds a turn, now 1 to 4

The language model moved off the RunAnywhere llama backend onto llama.rn
(llama.cpp with Metal), for reasons measured rather than assumed:

- The previous binary loaded every model at a 2048-token cap because the
  context option never reached it, and cleared its cache before every
  generation, so a ten-turn run paid full prefill ten times.
- llama.rn runs the 2.6B model on the iPhone 15 GPU at about 250 tokens/s
  prefill and 25 tokens/s decode, honours an 8k context, enforces a thinking
  budget in the sampler, and keeps prompt-state checkpoints for hybrid models
  like LFM2.5, so the system prompt is processed once per session.
- The system prompt is now constant for the whole session and warmed at
  load; per-request steering rides in its own turn. The router has its own
  engine lane on the same weights, so neither prompt evicts the other.

Measured on an iPhone 15 with LFM2.5-2.6B: "hello" in 0.9 s, "how much
battery do I have" in 1.8 s, teaching a three-step phrase in 16 s, saying it
back in 0.2 s.

## Reliability: the model only sees what it should

- A grammar-constrained router pass decides which abilities a message needs;
  "none" means conversation with every tool refused. Greetings no longer run
  taught phrases or read the battery.
- Reflexes execute unambiguous commands and taught phrases without the model.
- Deterministic guards became execution refusals with reasons instead of
  hidden tools, so the prompt never changes shape.
- Unknown tool parameters are rejected by name; a tool called three times in
  one run is switched off; a fast turn that narrates instead of acting gets
  one corrective nudge with thinking reopened.
- Questions about a taught phrase describe it instead of running or
  redefining it; remembered facts that match the message are injected so
  memory questions are answered directly.
- Teaching paraphrases ("If I ever ask for focus mode…", "Make me a shortcut
  called bedtime…") are recognised, and the phrase is extracted for the model.
- Deferrals with a clock time get the minute offset computed for them.

Rig results on LFM2.5-2.6B, general suite: 78% → 94% (without the router),
90% with the router on; demo suite 90% → 100%. LFM2.5-1.2B was evaluated as
the fast default and rejected: 19 to 31% on the same suite.

## New in the app

- Redesigned throughout: a paper-and-ink instrument look, light and dark, a
  living Core mark, receipts for every run with steps, seconds and tokens/s,
  live thinking glimpses and streamed answers.
- Home with capability cards, Brain (models, engine knobs, on-phone
  benchmark), Memory (facts, taught phrases with steps, scheduled runs, all
  editable), Tools, Settings, Diagnostics with a live log.
- A per-message "tools / chat only" switch on the composer.
- New tools: contacts lookup (names resolve to numbers for texts and calls),
  Reminders, clipboard, open URL / maps. Scheduled runs post a notification
  at their due time. `minimus://ask?q=…` opens the app and runs a request,
  for Shortcuts and the Action button.
- Thermal awareness: the thinking budget shrinks when the phone reports
  thermal pressure, and the chat says so.
- An on-device QA bridge driven from a laptop over Wi-Fi (`scripts/qa`).

## Verified

- 54 harness unit tests, eval runner tests, both typechecks clean.
- Built, installed and exercised on an iPhone 15 (iOS 26.6) from a Mac.
