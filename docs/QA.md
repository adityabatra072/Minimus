# QA plan

Four layers, because they fail differently.

1. **Unit tests, on a laptop** (`npm test`): the parser, the loop's retry and
   refusal paths, reflexes, the router's parsing and safety nets, routing
   composition, schedule parsing.
2. **The rig, on a laptop** (`npm run eval`): the shipping composition against
   the real model via `llama-server`, with `--raw` so the prompt is the byte-
   identical one the phone sends and `--router` so the router pass runs first.
   `suites/general.yaml` holds paraphrases, ordinary requests, conversation
   that must call no tool, and conversation after a phrase was taught (the
   case that once ran the phrase). Score before changing anything; score after.
3. **Checks and deep checks, on the phone** (Diagnostics screen, or
   `node scripts/qa/qa.mjs checks` / `deep`): deterministic plumbing checks in
   under a second, then every subsystem exercised for real: voice round trip,
   MCP, custom tools, vision, notifications, calendar write-and-read-back,
   web search, storage round trips.
4. **Real use, on the phone** (`scripts/qa/seq.sh "…" "…"`): sentences a
   person would type, through the exact chat path, with what appeared in the
   thread and every diagnostic line reported back to the laptop.

## Driving an iPhone from a Mac

There is no adb on iOS, so the app carries a QA bridge
(`apps/mobile/src/services/qaBridge.ts`). It polls a tiny HTTP server on the
laptop for commands and posts results back; a Debug build finds the server
next to Metro, a Release build needs `scripts/ios/device.sh qa-host x
<mac-ip>:8787` once. It is off unless one of those is present.

```sh
node scripts/qa/qa.mjs serve                 # once
node scripts/qa/qa.mjs ping                  # handlers the app registered
scripts/qa/seq.sh "hello" "what did I ask you to do when I say wind down?"
node scripts/qa/qa.mjs screenshot shot.jpg
node scripts/qa/qa.mjs state                 # engine, thermal, memory, settings
node scripts/qa/qa.mjs bench                 # prefill / decode tokens per second
node scripts/qa/qa.mjs logs | tail -60       # the [minimus] diagnostic ring
node scripts/qa/qa.mjs navigate brain        # brain|tools|memory|settings|history|diagnostics|chat
node scripts/qa/qa.mjs run approve '{"ok":true}'   # answer a pending approval card
```

Building and installing: `scripts/ios/device.sh all Debug` (two xcodebuild
passes on a clean derived-data directory; see the script for why).

## What a real-use pass looks like

Run in this order; each line says what proves it worked.

| Say | Proves |
|---|---|
| hello · how's it going? | router says none, no tools, about a second |
| turn on the flashlight · torch off | reflex, 0.2 s, torch actually toggles |
| how much battery do I have? | reflex reads the device |
| remember that my locker code is 4471 · what's my locker code? | memory write; the answer comes from injected facts, no tool |
| New rule: when I say wind down, … · wind down · what did I ask you to do when I say wind down? | teach (only define_macro runs), replay reflex, question describes instead of running |
| what's on my calendar tomorrow? | calendar read with gaps, receipt summary |
| find me an hour for the gym tomorrow afternoon and put it in | judgment plus calendar_create; schedule_task refused |
| in 2 minutes check my battery and tell me if it changed | schedule_task with "+2", notification at due time, the run fires |
| text Sam that I'm running late | contact resolves, approval card, Messages opens prefilled |
| who won the last Monaco Grand Prix? | web search with sources |
| Tap "chat only", ask anything | no tool can run |

Watch the receipt footers: steps, seconds, tokens/s and the route. Watch
`health:` lines in the log; when thermal reads serious the phone is throttling
and timings are not representative.

## Reading a failing run

`node scripts/qa/qa.mjs logs` carries, per run: `route [...]` with the raw
router output, `tool groups`, every `tool … args=` and its result, `refused`
lines with the reason the model was given, `retry:` reasons, `gen END` with
prefill and decode numbers and how much of the prompt came from cache, and
`health:` with thermal state and memory. Two slow runs look identical in the
UI and are different underneath:

- `cached 1` on every generation: the prompt cache is being wiped, usually
  because something changed the system prompt between passes.
- `cached 1400+` but 5 tok/s: the phone is hot. Check `health:`.

## Clock, voice and history scenarios (v2.1)

```
scripts/qa/seq.sh "wake me at 6:45" "timer for 3 minutes" "set an alarm for 7 every day" "what's my day look like"
node scripts/qa/qa.mjs navigate clock       # Clock screen: alarms/timers/stopwatch
node scripts/qa/qa.mjs deep                 # includes "Voice stack (recognizer + voices)"
```

Expect: the first three are reflexes (0.2 s, receipt says "reflex"); the
fourth calls `daily_brief` and answers in a few sentences. On iOS 26 the
lock screen shows the AlarmKit countdown; on 17.5–18 a notification fires.

Voice cannot be driven from the laptop. Manual: tap the mic, say "turn on
the flashlight" quickly and mumbled; the composer should show live words
and the diag log a `voice corrected:` line when the model repaired it.
Say "Talk to Minimus" to Siri once the app has been launched at least once
(App Shortcuts register on first launch).

## Manual passes nothing can automate

- **Wake word**: hands-free on, say "Minimus, what's my battery?" out loud.
- **Image picking**: the OS photo picker returns a usable path; the vision
  pass underneath is covered by the deep checks.
- **Spotify playback**: the beat proves the track resolves and the app
  opens; audio is a human ear.
- **Permission prompts**: notifications are asked at app start; calendar,
  reminders and contacts at first use. Grant them once.
