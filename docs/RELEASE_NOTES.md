# Minimus v1.0.0

A complete agentic AI system that runs on a phone. A 2.6B-parameter model runs
locally and drives a real agent loop: it calls tools, remembers things, learns
new commands, schedules its own future runs, sees images, and speaks. Except
for web search and any remote integrations you add, it works in airplane mode.
There is no server component.

## What it does

- **Tool-calling agent loop** tuned for small on-device models: intent-routed
  tool exposure, one call per turn, parse and truncation recovery, approval
  cards for anything that sends on your behalf
- **Phone control**: flashlight, brightness, battery and storage, open apps,
  timers, alarms, notifications, clipboard
- **Calendar with judgment**: the calendar tool returns events plus computed
  free gaps, so "find me 90 minutes tomorrow that is not before 10am and not
  right after standup, and put it in" works offline
- **Persistent local memory**: what you tell it survives force-quitting the app
- **Taught commands**: "New rule: when I say wind down, dim the screen, turn
  the flashlight off, and remind me to set my alarm." Saying "wind down" later
  replays the steps deterministically
- **Deferred agency**: it can schedule a future agent run, wake itself, compare
  against what it recorded earlier, and notify you
- **Web search** with tap-able source citations; Spotify track resolution
- **MCP client**: connect any streamable-HTTP MCP server (Slack, Google
  Calendar, GitHub, your own) from the Tools screen; every call is approval
  gated
- **Custom HTTP tools** you define in the UI
- **Voice**: tap-to-talk with on-device Whisper and Piper, plus a hands-free
  wake phrase
- **Images**: attach a photo and the agent inspects it with an on-device VLM
- **Sessions, history, settings**, per-item control over everything the agent
  remembers, and optional routing to any OpenAI-compatible endpoint with a
  visible on-device/cloud badge

## Honest numbers

Measured on the two devices used for QA, same build, same model
(LFM2.5-2.6B Q4_K_M):

| | iPhone 15 (A16) | OnePlus 9R (SD870) |
|---|---|---|
| Simple tool run (flashlight) | about 20 s | about 230 s |
| Memory write beat | about 25 s | about 289 s |
| System self-checks | 0.2 s | 0.2 s |

The gap is prefill throughput on the CPU: roughly 7 to 11 tokens per second on
the SD870. The app is usable on the iPhone and slow but correct on the 9R. The
NPU path is the roadmap answer for older Android hardware.

Every model load currently gets a 2048-token context regardless of what the app
requests, because of an SDK-level key mismatch documented in
`docs/SDK-FINDINGS.md`. The harness is tuned to work inside that budget.

## Found and fixed during the QA pass

Every one of these was found by operating the app on real hardware, not by
reading the code:

- Android never requested runtime permissions, so calendar and notification
  tools failed permanently on Android 13+ with no prompt to explain why
- Connecting to a self-hosted MCP server or local model endpoint was
  impossible on Android release builds: cleartext HTTP to loopback and LAN
  addresses is blocked by default, and it surfaced only as "Network request
  failed"
- With the keyboard open, the composer was pushed off screen on Android
- The app opened an empty chat on every launch instead of the conversation you
  were last in
- Cancelling a run rendered a literal "<think>" bubble and reported the run as
  completed
- A run whose tool calls all succeeded was reported as an error when its
  closing sentence ran out of context
- Every prompt carried the memory and macro tools regardless of the request:
  53% of a "turn on the flashlight" prompt, re-processed on every turn
- Thinking overruns retried in the same space that had just overflowed
- Concatenated tool calls from one reply parsed as zero calls, so batched
  work silently became prose

## Verified in this release

- 9 deterministic system checks pass on both platforms (tool schemas, prompt
  budget, intent routing, tool-call parsing, schedule parsing, native bridges,
  storage, stores, live calendar)
- 14 deep feature checks run against the real subsystems on both platforms:
  device tools, memory, macros, scheduled tasks, approval gating, session and
  settings persistence, notifications and timers, a calendar write read back,
  web search, custom tools, MCP, vision, and a voice round trip
- MCP proven end to end on hardware: a server added by URL in the Tools
  screen, its tools discovered, the agent choosing one, the run pausing for
  approval, the call reaching the server, and the result coming back as an
  answer
- Deferred agency proven on both platforms: the app scheduled a future agent
  run, woke itself minutes later, compared against what it had recorded, and
  reported
- Agent beats run on both platforms from the in-app Rehearsal screen, with a
  shareable report
- Release builds work on Windows for Android and via GitHub Actions for iOS

Known open item: the synthetic voice round trip (text to speech, then speech
to text) does not yet transcribe cleanly; the live microphone path is
unaffected, and the check now reports the audio format it received so the
mismatch can be pinned down.

## Install

**Android**: download the APK and install it. It is signed with a debug
keystore, so Play Protect will warn; that is expected for a sideloaded build.

**iOS**: the IPA is unsigned. Sign it with your own Apple ID using a
sideloading tool, or open `apps/mobile/ios` in Xcode.

First launch downloads the default model (about 1.7 GB). Voice and vision
models download on first use of those features.

## Known limits

- Scheduled tasks fire while the app is alive; overdue tasks run on next launch
- Web search, Spotify and MCP servers need the network
- A 2.6B model orchestrates tools well and answers trivia badly; the tool
  design leans into that
- iOS cannot automate other apps; Android phone-navigation via
  AccessibilityService is not in this release
