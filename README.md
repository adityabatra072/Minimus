# Minimus

A complete agentic AI system that runs on a phone. A local LLM (2.6B parameters, GGUF via llama.cpp) drives a real agent loop with tool calling, persistent memory, self-scheduled tasks, voice, and image understanding. Built on the [RunAnywhere SDKs](https://github.com/RunanywhereAI/runanywhere-sdks) for iOS and Android.

Everything except web search, Spotify, and remote integrations works in airplane mode. Conversations, memory, and taught behaviors live on the device. There is no server component.

## What it does

- Tool-calling agent loop tuned for small on-device models: intent-based tool routing, one call per turn, parse retries, truncation recovery, approval cards for anything that sends on your behalf
- Phone control: flashlight, brightness, battery and storage, open apps, timers, alarms, notifications
- Calendar with judgment: the calendar tool returns events plus precomputed free gaps, so "find me 90 minutes tomorrow that is not before 10am and not right after standup, and put it in" works offline
- Persistent local memory: "remember that my appointment is Thursday at 4pm" survives force-quitting the app
- Taught macros: "New rule: when I say wind down, set brightness to 20 percent, turn the flashlight off, and remind me to set my alarm." Saying "wind down" later replays the steps deterministically
- Deferred agency: "check my battery again in 3 minutes and tell me if it dropped" schedules a fresh agent run that wakes, compares against remembered state, and notifies
- Web search with tap-able source citations; Spotify track resolution and autoplay
- MCP client: connect any streamable-HTTP MCP server (Slack, Google Calendar, GitHub, or your own) from the Tools screen. Server tools appear in the agent, each call approval-gated
- Custom HTTP tools registered from the UI: give the agent any API with a name, description, URL, and parameters
- Voice: tap-to-talk with on-device Whisper STT and Piper TTS, plus a hands-free mode with a wake phrase
- Images: attach a photo and the agent inspects it with an on-device VLM (SmolVLM-500M)
- Model manager: search Hugging Face, download GGUF models, and swap the brain. Optional routing to any OpenAI-compatible endpoint, with an on-device/cloud badge that always tells you which one answered

## Honest numbers

An agent turn takes roughly 15 to 45 seconds on a phone CPU. Multi-step tasks take minutes. The app narrates what the agent is doing while it runs. Scheduled tasks fire while the app is alive; overdue tasks run on next launch (the OS suspends background apps). A 2.6B model is a doer, not an oracle: it orchestrates tools well and answers trivia badly, and the tool design leans into that.

## Layout

| Path | What |
|---|---|
| `packages/agent-core` | Pure-TypeScript agent harness: loop, tool registry, model adapters, per-model policies. No React Native imports; runs and tests on any Node. |
| `packages/eval` | YAML scenario suites and a runner that scores tool-call validity per model against any OpenAI-compatible endpoint. |
| `apps/mobile` | React Native app: screens, native tool modules (Kotlin/Objective-C), voice and vision services, MCP client. |
| `docs/` | Demo storyboards and content. |

## Getting started

Prerequisites: Node 20+, and for device builds the usual React Native toolchains (Android Studio/SDK for Android; the iOS app is built by the included GitHub Actions workflow on a macOS runner).

```sh
npm install
npm test                                   # agent-core unit tests
npm run eval -- --suite demos --model lfm2.5-2.6b   # score scenarios against a local model server
```

The eval rig talks to any OpenAI-compatible endpoint (llama-server, rcli serve, or a cloud key), so the whole agent harness is developed and validated without a device in the loop.

### Android

```sh
cd apps/mobile
npm run android
```

### iOS

The `ios-build` workflow produces an unsigned IPA on every push. Sign and install it with your own Apple ID using any sideloading tool, or open `apps/mobile/ios` in Xcode on a Mac. The first launch downloads the default model (about 1.7GB).

## Models

The built-in catalog targets phones with around 6GB of RAM: LiquidAI LFM2.5-2.6B (default agent model), Qwen3.5-4B (deeper reasoning), and LFM2-1.2B-Tool (fast tier), plus larger options for bigger devices. Voice and vision models (Whisper Tiny, Piper, SmolVLM-500M) download on first use. Any GGUF from Hugging Face can be added from the model manager.

## Design notes

The harness assumes small models fail in specific ways and engineers around them: tools the model chronically misroutes are hidden when intent detection says they cannot be right; usage hints render inline under each tool; oversized tool outputs are truncated before they starve the context; a turn that produces nothing gets one explicit nudge to continue; a tool call cut off by the generation window is retried with a fresh one. The eval suite mirrors the app's exact prompt composition, because an eval that tests a nicer prompt than the one that ships measures nothing.
