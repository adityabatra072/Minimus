# QA plan

Three layers, because they fail differently:

1. **System checks** (Rehearsal screen, "system checks" button). Deterministic,
   under a second, no model involved: tool schemas, prompt budget, intent
   routing, tool-call parsing, schedule parsing, native bridge, storage,
   stores, live calendar access. Run these first — a red check means the
   plumbing is broken and every agent beat after it is noise.
2. **Deep checks** (Rehearsal screen, "deep"). Every feature the demo beats do
   not touch, run against the real subsystem: a TTS-to-STT voice round trip
   (no microphone needed), MCP server connections, custom HTTP tools, the
   vision model, notifications and timers, a calendar write read back, web
   search, and storage round trips for memories, macros, scheduled tasks,
   sessions and settings — each cleaning up after itself. A check whose
   prerequisite is missing reports "skipped", never a quiet pass. Minutes on
   first run if it has to download the voice pack.
3. **Agent beats** (Rehearsal screen, "Run all beats"). Real model, real tools,
   on the real device. Slow (20 to 90 seconds each on an iPhone 15, several
   minutes each on an older Android) and the only way to catch model-behavior
   regressions.

All three are covered by the shareable report ("share report" next to the
tally).

## The fourth layer: does it work for anyone but us

Beats are the demo script. Passing them says nothing about the sentence a real
person types, and it is easy to tune a harness until it fits its own tests. Two
things guard against that, both on a laptop, no device required:

```sh
npx tsx packages/eval/src/routingCheck.ts general   # every needed tool exposed?
npm run eval -- --suite general --endpoint <url> --model lfm2.5-2.6b
```

`suites/general.yaml` is deliberately not the demo: paraphrases of each beat in
words the beat never used ("If I ever ask for focus mode…" for the teach beat),
plus ordinary requests no beat covers, plus two that must call NO tool. Every
scenario sets `route: true`, so it runs the shipping composition
(`composeRun`), not a hand-written tool list — a rig that restates the routing
in YAML is measuring the agent you remember writing.

`routingCheck` answers the cheaper half without a model: was the tool the task
needs even exposed? A model cannot call a tool it was never given, and that
failure looks exactly like a model failure in the logs. It found 7 of 16
ordinary requests were unwinnable before the exposure change.

## Before a run

- Model downloaded and loaded (open the app once and let it settle)
- Calendar permission granted, with a few events on tomorrow
- Notification permission granted
- Phone unplugged is fine; plugged in is fine too
- For the Spotify beat: Spotify installed and logged in, network on

## Beat coverage

| Beat | Proves |
|---|---|
| private-remember | memory write, on-device storage |
| watchdog-arm | deferred agency: schedules a future agent run |
| teach-macro | records a new phrase without performing its actions |
| run-macro | replays a taught phrase deterministically |
| calendar-judgment | reads the calendar, satisfies fuzzy constraints, writes back |
| private-recall | recall after the app was killed |
| flashlight | native device control |
| spotify (opt-in) | track resolution and playback, leaves the app |

## Manual passes nothing can automate

Only three, and each needs a human because it needs a human's voice, the OS
picker, or another app's UI:

- **Wake word**: enable hands-free in Settings, say "E.V, what's my battery?"
  out loud. The transcript-matching logic is covered by the routing checks, but
  a real spoken trigger is not automatable.
- **Image picking**: the OS photo picker itself. The VLM path underneath is
  covered by the deep checks; this confirms the picker returns a usable path.
- **Spotify playback**: the beat proves the track resolves and the app opens;
  confirming audio actually plays is a human ear.

Worth eyeballing once per release, though all of it is machine-checked:
approval cards pausing a run, the on-device/cloud badge flipping when a remote
endpoint is enabled, and Settings listing every memory, taught phrase and
scheduled task with a working delete.

## Driving QA from a laptop

Android, without touching the phone:

```sh
source tools/qa/adb-qa.sh
qa_launch
qa_ask "turn on the flashlight"          # types, sends, waits for the run
qa_log_tail 20                            # what the agent did
qa_tap_text "More options"; qa_tap_text "Rehearsal"
```

iOS: sideload the IPA, open the Rehearsal screen, run the checks and beats,
then "share report" and paste the report. The device console
(`idevicesyslog | grep minimus`) carries the same lines live.

## Reading a failing beat

The report and the syslog both carry, per failing beat: the tools that were
called, what the model said, its raw output (thinking stripped), and any
parse-retry reasons. `gen END` lines give the per-generation shape: end
reason, event count, thinking characters, answer characters, prompt
characters. Two failures look identical in the UI and are completely
different underneath:

- `thought=0ch text=0ch` — the model produced nothing (runtime or prompt
  problem)
- `thought=2000ch text=0ch` — the model thought itself out of budget (a
  deliberation problem; the harness nudges, then forces answer mode)
