# minimus — Minimus

On-device agentic AI demo app for iOS (iPhone 15) and Android, built on the
[RunAnywhere SDKs](https://github.com/RunanywhereAI/runanywhere-sdks). A local LLM
(LFM2.5-2.6B / Qwen3.5-4B, GGUF via llama.cpp) runs a real agent loop with tool
calling — flashlight, open apps, calendar, alarms, web search, Spotify, scheduling —
plus a full on-device voice pipeline (VAD → STT → LLM → TTS).

## Layout

| Path | What |
|---|---|
| `packages/agent-core` | Pure-TS agent harness: loop, tool registry, model adapters, per-model policies. No RN imports; testable on any Node. |
| `packages/eval` | YAML scenario suites + runner; scores tool-call validity per model. |
| `apps/mobile` | React Native app (RunAnywhere RN SDK, native tool modules). |
| `models/` | Local GGUF bundles for Windows-side eval (gitignored). |

## Dev quickstart (Windows)

```sh
npm install
npm run test          # unit tests (vitest)
npm run eval -- --suite demo --model lfm2.5-2.6b   # scenario eval vs local model
```

Local model eval uses `rcli` (RunAnywhere CLI) or any OpenAI-compatible endpoint.
