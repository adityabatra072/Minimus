# QA plan

Two layers, because they fail differently:

1. **System checks** (Rehearsal screen, "system checks" button). Deterministic,
   under a second, no model involved: tool schemas, prompt budget, intent
   routing, tool-call parsing, schedule parsing, native bridge, storage,
   stores, live calendar access. Run these first — a red check means the
   plumbing is broken and every agent beat after it is noise.
2. **Agent beats** (Rehearsal screen, "Run all beats"). Real model, real tools,
   on the real device. Slow (20 to 90 seconds each) and the only way to catch
   model-behavior regressions.

Both are covered by the shareable report ("share report" next to the tally).

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

## Manual passes the beats cannot cover

These need a human (or an adb driver) because they involve permissions,
attachments, or other apps:

- **Voice**: tap the mic, say "turn on the flashlight". First tap downloads the
  voice pack (about 220MB). Then enable hands-free in Settings and try
  "E.V, what's my battery?"
- **Images**: attach a photo with the composer's + button and ask what it is.
  First use downloads SmolVLM (about 500MB).
- **Sessions**: send a message, force-quit, reopen — the chat is still there.
  New chat (+), history (menu → Chats), reopen an old one.
- **Settings**: toggle approvals off and confirm an email request stops asking;
  toggle a remote endpoint on and confirm the header badge flips to "cloud".
- **Tools screen**: switch a built-in tool off and confirm the agent stops
  using it; add an HTTP tool; add an MCP server and confirm its tools appear.
- **Agent data**: Settings shows every memory, taught phrase and scheduled
  task, each individually deletable.
- **Approval cards**: ask it to email someone and confirm the run pauses.

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
