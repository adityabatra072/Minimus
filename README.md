# Minimus

A complete agentic AI system that runs on a phone. A 2.6B-parameter model
(LFM2.5, GGUF) runs on the phone's GPU through llama.cpp and drives a real
agent loop: tool calling, persistent memory, taught phrases, self-scheduled
runs, voice and image understanding. Everything except web search, Spotify
and any remote integrations you add works in airplane mode. There is no
server component.

## What it does

- **Acts on the phone**: flashlight, brightness, battery and storage, open apps
  and links, clipboard, timers, alarms, notifications, Reminders.
- **Calendar with judgment**: the calendar tool returns events plus
  precomputed free gaps, so "find me 90 minutes tomorrow that is not before
  10am and not right after standup, and put it in" works offline.
- **Remembers**: "remember that my locker code is 4471" survives force-quitting
  the app; matching facts are handed to the model before it answers.
- **Learns phrases**: "New rule: when I say wind down, set brightness to 20
  percent and turn the flashlight off." Saying "wind down" later replays the
  steps in 0.2 seconds, without the model.
- **Comes back later**: "in 20 minutes check my battery and tell me if it
  dropped" schedules a fresh agent run and a notification at the due time.
- **Messages the right person**: names resolve through Contacts; email, text
  and call always show an approval card first.
- **Looks things up** with tappable sources; plays exact Spotify tracks.
- **Extends**: connect any streamable-HTTP MCP server or register an HTTP API
  as a tool from the Tools screen; each call is approval-gated.
- **Talks and sees**: tap-to-talk with on-device Whisper and Piper, a
  hands-free wake phrase, and photo understanding with SmolVLM.
- **Shortcuts**: `minimus://ask?q=turn%20on%20the%20flashlight` opens the app
  and runs the request, so the Action button, Back Tap or any Shortcut can
  drive it.

## Honest numbers (iPhone 15, LFM2.5-2.6B on Metal)

| Request | Time |
|---|---|
| "hello" | 0.9 s |
| "how much battery do I have" | 1.8 s |
| "wind down" (taught phrase) | 0.2 s |
| "turn on the flashlight" | 0.2 s |
| teaching a three-step phrase | 16 s |
| "what's on my calendar tomorrow" | 8 to 20 s |

Prefill runs at about 250 tokens/s and decode at 24 to 27 tokens/s when the
phone is cool. Sustained GPU load heats an iPhone 15 within a few minutes and
iOS throttles it to a quarter of that; the app shrinks its thinking budget and
says so when the OS reports thermal pressure. Scheduled tasks fire while the
app is alive; a task due while it is closed posts a notification and runs on
the next launch.

## How it stays fast and out of trouble

`docs/HOW-IT-WORKS.md` walks through one request in plain language. The
short version:

1. **Reflexes** execute unambiguous commands and taught phrases instantly.
2. A **grammar-constrained router pass** on the same model decides which
   abilities the message needs; "none" means conversation with every tool
   refused. It runs in its own engine lane so its cached prompt survives.
3. **One constant system prompt per session**, warmed at load. Per-request
   steering (clock, guards, remembered facts, taught-phrase steps) rides in a
   separate turn, so the engine serves the ~1500-token tool list from cache
   and each request pays only for itself.
4. **Deterministic guards** refuse the tools that cannot be right for a
   sentence, with a reason the model can act on, instead of hoping the prompt
   persuades it.
5. **Adaptive thinking**: LFM2.5 deliberates for decisions, skips it for
   confirmations and conversation, and is cut off at a budget.

## Layout

| Path | What |
|---|---|
| `packages/agent-core` | Pure-TypeScript harness: loop, router, reflexes, tool registry, prompt layout, parsing, per-model policies. Runs and tests on any Node. |
| `packages/eval` | YAML scenario suites and a runner that sends the phone's exact prompt to `llama-server` and scores tool calls per model. |
| `apps/mobile` | React Native app: screens, engine (llama.rn), native tools (Objective-C/Kotlin), voice, vision, MCP client, QA bridge. |
| `scripts/qa` | Drive the app on a real iPhone from a laptop over Wi-Fi. |
| `scripts/ios` | Build, install and launch on a connected iPhone from the terminal. |
| `docs/` | How it works, QA plan, SDK findings, release notes. |

## Getting started

Prerequisites: Node 22+, Xcode 26 with CocoaPods for iOS, Android Studio for
Android, and `brew install llama.cpp` if you want the laptop eval rig.

```sh
npm install
npm test                                        # harness + eval unit tests
npm run build -w @minimus/agent-core
```

### iOS on a connected iPhone

```sh
cd apps/mobile/ios && pod install && cd -
scripts/ios/device.sh all Debug                 # build, install, launch
```

Set `DEVELOPMENT_TEAM` in `apps/mobile/ios/mobile.xcodeproj` to your team.
The first launch downloads the chosen model (731 MB or 1.6 GB). To skip the
download, push a GGUF over USB:

```sh
xcrun devicectl device copy to --device <udid> --source models/LFM2.5-2.6B-QAD-Q4_0.gguf \
  --destination Documents/models/LFM2.5-2.6B-QAD-Q4_0.gguf \
  --domain-type appDataContainer --domain-identifier ai.minimus.app
```

### Driving the phone from the laptop

```sh
node scripts/qa/qa.mjs serve                    # once, on the Mac
scripts/qa/seq.sh "hello" "turn on the flashlight" "what's on my calendar tomorrow?"
node scripts/qa/qa.mjs screenshot out.jpg
node scripts/qa/qa.mjs logs | tail -40
```

Debug builds find the QA server next to Metro automatically; a release build
needs `scripts/ios/device.sh qa-host x <mac-ip>:8787` once.

### The eval rig

```sh
llama-server -m models/LFM2.5-2.6B-QAD-Q4_0.gguf --port 8091 -c 8192 -ngl 99
npm run eval -- --suite general --endpoint http://127.0.0.1:8091 --model lfm2.5-2.6b --raw --router --repeats 2
```

`--raw` sends the byte-identical prompt the phone sends; `--router` runs the
router pass first, as the app does. `suites/general.yaml` is deliberately not
the demo: paraphrases, ordinary requests, and conversation that must call no
tool. Current scores for LFM2.5-2.6B: 90 to 94% general, 100% demos.

## Models

Curated for a 6 GB phone: LFM2.5-2.6B (default; thinks when the ask needs
judgment), LFM2.5-1.2B-Instruct (fast, weaker at picking tools: 19 to 31% on
the general suite, offered as an explicit choice), LFM2-1.2B-Tool, Qwen3.5-4B
for big devices, plus any GGUF from Hugging Face via the Brain screen. Whisper
Tiny, Piper and SmolVLM-500M download on first use.

## License

Apache 2.0. See `LICENSE`. The RunAnywhere SDK used for the voice pipeline and
llama.rn carry their own licenses.
