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

## Verified

- Android, on device: context window 4096, 9/9 system checks including the
  full tool set at ~1188 tokens of that window, and the agent beats re-run
  against full exposure
- Routing: 0 of 16 general-suite requests lose their tool, checked without a
  model by `npx tsx packages/eval/src/routingCheck.ts general`
- 38 harness unit tests

## Known limits

Unchanged from v1.0.0, plus: the general suite proves the model is GIVEN the
right tool, not that it picks it. That half needs an OpenAI-compatible endpoint
(`npm run eval -- --suite general --endpoint <url>`) or a device run per
scenario.
