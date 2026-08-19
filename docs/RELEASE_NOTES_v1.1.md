# Minimus v1.1.0

One change makes the rest possible: the model now gets the context window the
app asks for. Everything else here is what stopped being necessary once it did.

## The context window: 2048 to 4096

Every model loaded at 2048 tokens no matter what the app requested. Measured on
a OnePlus 9R, before and after:

```
before  Final context size: 2048 (fitted=4096, train=128000, cap=2048)
after   Final context size: 4096 (fitted=4096, train=128000, cap=8192)
```

The device could always fit 4096 and the model trains at 128k. Three defects
combined, and the first hides the other two (`docs/SDK-FINDINGS.md` §5): the
llamacpp plugin takes commons' `config_json`, names the parameter
`/*config_json*/`, never reads it, and fills a session descriptor whose
`options_json` field it leaves unset. Patching only the other two changes
nothing observable.

The fix is `patches/engine/llamacpp-honour-context-length.patch`. Because the
RN packages ship prebuilt native artifacts, it takes effect only once the
engine is rebuilt: `scripts/engine/build-android-engine.ps1` does Android from
Windows with no Mac and no WSL, and `.github/workflows/ios-patched-engine.yml`
does iOS on the same macOS runner that already builds the IPA.

## The app stops guessing what you meant

With 2048 tokens, the full tool set (1261 tokens) did not fit, so a keyword
router picked which tools the model was allowed to see. That router decided
what the agent could do from the words you happened to use, and it was wrong
constantly outside the demo script. A new suite of ordinary requests
(`packages/eval/suites/general.yaml`) measured it: **7 of 16 never saw the tool
they needed**.

- "How much space have I got left on this phone?" routed to `comms`, because
  "phone" is a comms trigger. `device_info` was never on the table.
- "Who won the Monaco Grand Prix this year?" got no `web_search`.
- "Let Sam know I am running late" got no `send_sms`.
- "Remind me what my therapist is called" got no `recall`, because "remind"
  looks like scheduling.

Those are not model failures. You cannot call a tool you were not given. Every
group except vision (which is attachment-gated) is now exposed, and the model
decides. The deterministic exclusions stay, because "hide the tool that cannot
be right while the user is teaching a phrase" is a different and defensible
claim from "guess the topic from the wording".

## Fixed

- **Two generations on one context.** A scheduled task could come due mid-run
  and start a second generation on the single native LLM — caught 1.5 seconds
  into a rehearsal beat, which then took 793s against a usual 300s. The chat
  screen had a lock; the scheduler bypassed it. One `runLock` now covers chat,
  rehearsal and the scheduler, and a task that arrives busy waits for the next
  tick.
- **A correct tool call thrown away over a missing bracket.** The model emitted
  a complete `define_macro` with all three steps and no closing `]`; the run
  was reported as "no tools" and cost a 100-second retry. Unterminated and
  bare calls are now salvaged when they name a registered tool.
- **The rehearsal was not testing the app.** Each beat carried its own tool
  list, so a green run could not tell you whether the app exposes the right
  tools for a request. Beats, the scheduled runner, the chat screen and the
  eval rig now all call one `composeRun()`.

## Also fixed, all of it found by watching runs rather than reading code

- **Two generations on one context.** A scheduled task could come due mid-run
  and start a second generation on the single native LLM, caught 1.5 seconds
  into a rehearsal beat. One run lock now covers the chat screen, the
  rehearsal and the scheduler.
- **A correct tool call thrown away over a missing bracket.** The model
  emitted a complete `define_macro` with no closing `]`; the run was reported
  as "no tools" and cost a 100-second retry. Unterminated and bare calls are
  salvaged when they name a registered tool.
- **A run dying because the phone locked.** No crash, no error; the tell was
  the battery cooling from 47C to 30C. A run is minutes long, so the run lock
  holds the screen awake for its duration.
- **schedule_task firing immediately.** "In 3 minutes" became an absolute
  timestamp computed before several minutes of thinking, so it was already
  stale when the tool ran. The schema asks for "+N", a past time is refused
  with a message saying what to send, and `parseWhen` now also accepts
  "tomorrow 12:15" and "+1d 12:15" — a gap that had the model retrying a
  format nothing would accept.
- **Teaching a phrase performing the phrase.** Under full exposure the model
  did the lesson instead of recording it (`set_brightness`, `flashlight`,
  `send_notification`, no macro). Hiding those tools broke it differently —
  the steps are WRITTEN in tool names, so it emitted prose the schema rejects.
  Visibility and runnability are now separate: teaching exposes what a macro
  step can contain, and `allowExecuteOnly` lets only `define_macro` actually
  run.
- **Calendar placement reaching for the scheduler.** "Put it in" produced
  `calendar_query, schedule_task, calendar_query, schedule_task,
  schedule_task` and never `calendar_create`, because the usage hint saying so
  is dropped on an overrun retry. Placement requests no longer see
  `schedule_task`.

## Verified on device

Android, OnePlus 9R, final build, thermally throttled at 46C throughout:

| Beat | Time | Tools |
|---|---|---|
| Private context — store | 1144.5s | `remember` |
| Watchdog — arm it | 1519.8s | `device_info, remember, schedule_task` |
| Teach a verb | 511.2s | `define_macro` |
| Say the verb | 354.4s | `run_macro` |
| Calendar judgment | 1500.7s | `calendar_query, calendar_create` |
| Private context — recall | 387.0s | `recall` |
| Bench: flashlight | 328.0s | `flashlight` |

7/7, plus 9/9 system checks. iOS ran the same suite 6/7 before the teaching
fixes, at 34s to 275s per beat — read the Android numbers as correctness, not
speed.

- Routing: 0 of 16 general-suite requests lose their tool, checked without a
  model by `npx tsx packages/eval/src/routingCheck.ts general`
- 39 harness unit tests

## Known limits

Unchanged from v1.0.0, plus: the general suite proves the model is GIVEN the
right tool, not that it picks it. That half needs an OpenAI-compatible endpoint
(`npm run eval -- --suite general --endpoint <url>`) or a device run per
scenario.
