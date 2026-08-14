# RunAnywhere SDK findings from building this app

Every SDK-level bug, gap, and sharp edge hit while building Minimus,
with impact, workaround used here, and the suggested upstream fix. Ordered by
severity as experienced. File references are against the runanywhere-sdks
monorepo.

## 1. generateStream silently discards thinking output by default

**Impact: critical.** With `reasoning` unset in `LlmOptions`, the runtime strips
thinking spans from the stream entirely. A hybrid reasoner (LFM2.5) that spends
a turn deliberating surfaces as a generation that produced zero events: the
caller sees an instant EOS and an empty answer. This presented as
nondeterministic "silent turns" on device and cost a week of misdirected
debugging (prompt formats, samplers, tool routing all got blamed first).

- Repro: LFM2.5-2.6B, any prompt that triggers deliberation,
  `llm.generateStream(prompt, { ... })` with no `reasoning` option. Watch a
  60-second generation return nothing.
- Workaround: `reasoning: { mode: 'on', includeInOutput: true }`.
- Suggested fix: when the loaded model is a mandatory-thinking family, default
  to surfacing reasoning (or fail loudly), never silently discard. At minimum
  document the stripping behavior on `generateStream`.

## 2. KV cache cleared before every generation

**Impact: high (performance).** `llamacpp_backend.cpp` (~line 1080) clears the
KV cache at the start of each generation. Multi-turn agent loops resend the
full prompt every turn and pay complete prefill each time: 10 to 30 seconds
per turn on a phone for a ~1k-token prompt that is 95 percent identical to the
previous turn's.

- Suggested fix: common-prefix detection against the previous request (the
  llama-server `cache_prompt` approach): keep the KV for the shared prefix,
  decode only the suffix. This is the single biggest latency lever for agentic
  use.

## 3. LFM2.5 chat template is unknown to llama_chat_apply_template

**Impact: high.** The template detector returns UNKNOWN for LFM2.5's jinja
template, so `apply_chat_template` falls back to a plain `role: content`
format with no end-of-turn token. The model emits EOS after a few tokens or
runs into the next turn.

- Workaround: the app formats the full prompt itself and uses the verbatim
  pass-through path in `build_prompt` (prompts containing `<|im_start|>` are
  used as-is).
- Related detail that cost real time: LFM2.5's generation prompt is
  `<|im_start|>assistant\n<think>` — thinking is forced open by the template.
  Verbatim-path callers must replicate that prefill themselves or the model is
  off-distribution. If the template can't be applied natively, consider a
  built-in LFM chat handler (llama.cpp upstream has one for LFM2).

## 4. Detokenizer swallows CONTROL special tokens, including tool-call wrappers

**Impact: medium-high.** LFM2.5's `<|tool_call_start|>` / `<|tool_call_end|>`
are CONTROL-type tokens and never appear in the detokenized stream, so a
harness cannot see the model's own tool-call delimiters. (`<think>`/`</think>`
are USER_DEFINED and do render.)

- Workaround: parse the bare pythonic call syntax (`[f(a='x')]`) without
  relying on the wrappers.
- Suggested fix: an option to render special tokens in the stream, or emit
  tool-call segments as typed stream events.

## 5. context_size hard-capped to 2048 when the memory fit check fails

**Impact: medium-high.** In `llamacpp_backend.cpp`, when `common_fit_params`
fails or errors, a user-requested context is capped straight to 2048 — even
when an intermediate value (3072, 4096) would fit. On a phone this halves the
generation budget of every deliberation-heavy turn.

- Suggested fix: on fit failure, retry at intermediate sizes instead of
  falling to the floor; log the final effective n_ctx at INFO so apps can see
  what they actually got, and surface it through the load result.

## 6. LoadOptions.contextLength was rejected by the RN load path

**Impact: medium (fixed locally, verify upstream).** `models.load` threw for
`contextLength` because the native load ABI did not carry it. Patched in the
local clone to pass through `ModelLoadRequest.context_length`; per
LoadOptionsSupport.ts, `threads` and `accelerator` still have no wire path.

## 7. Android build on Windows: NDK host tag

**Impact: medium (blocks Windows contributors).** The Android native build
resolves the NDK toolchain with a hardcoded non-Windows host tag; building on
Windows requires patching to `windows-x86_64` (done via postinstall script
`scripts/fix-runanywhere-windows.mjs` here and patched in the local SDK clone).

## 8. iOS build friction under Xcode 26

**Impact: medium (CI figured it out, others will hit it).**
- RunAnywhere pods need Swift 5 language mode under Xcode 26's strict
  concurrency or they fail to compile.
- `ENABLE_USER_SCRIPT_SANDBOXING=NO` is required for the pods' xcframework
  copy phases.
- First `xcodebuild` invocation reliably fails on XCFrameworkIntermediates
  ordering; an immediate retry links. CI runs the build twice on purpose.

## 9. rcli on Windows

**Impact: low-medium.** Runtime DLLs are not staged next to the executable
(manual copy needed), and path handling breaks on backslashes in some
subcommands. Details in the app repo's early setup notes.

## 10. Microphone capture is not on the public RN API

**Impact: low (component voice pipelines need it).** `AudioCaptureManager`
lives under `src/Features/VoiceSession/` and must be deep-imported. The
composed `voice.createSession` cannot call tools, so any tool-calling voice
agent has to build the pipeline from components — which needs mic frames.

- Suggested fix: export a public mic-frame source, or add tool-calling to the
  composed session.

## Verified-good along the way

For balance: the verbatim-prompt pass-through in `build_prompt`, the
download/extract pipeline for tar.gz model bundles, sherpa STT/TTS integration,
the VLM path (SmolVLM via `vlm.generate`), and the ONNX/llama.cpp backend
registration all worked as documented once reached.
