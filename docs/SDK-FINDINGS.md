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

## 5. `contextLength` never reaches the llama.cpp backend, so every model
loads at the 2048 default cap

**Impact: critical (quality and latency).** Confirmed on device, OnePlus 9R,
release build:

```
LLM.LlamaCpp: Final context size: 2048 (fitted=4096, train=128000, cap=2048)
```

The device fits 4096 and the model trains at 128k, but the context is 2048.
Three defects combine, and the first one is upstream of the other two — the
value never gets far enough for the key mismatch to matter:

1. **The llamacpp plugin drops `config_json` on the floor.** Commons does its
   part: `load_options_json()` builds `{"context_length":N}` and
   `create_backend_impl()` passes it to `llm_ops->create(path, config_json,
   ...)`. But `rac_backend_llamacpp_register.cpp::llamacpp_llm_create_impl()`
   names the parameter `/*config_json*/` and never reads it, then builds a
   `rac_runtime_session_desc_t` leaving `options_json` unset — even though the
   descriptor has that exact field. Its `create_session` then calls
   `rac_llm_llamacpp_create(path, nullptr, ...)`, so the engine is constructed
   with no config at all. The comment says so outright: "today we pass nullptr
   to rac_llm_llamacpp_create to use defaults."
2. **Key mismatch.** Even once a config arrives,
   `model_lifecycle_translation.cpp::load_options_json()` emits
   `"context_length"` while `llamacpp_backend.cpp::load_model()` reads
   `"context_size"`.
3. **The cap can only lower, never raise.** `context_size_ = std::min({fitted,
   train, max_default_context_})` with `max_default_context_` defaulting to
   2048, so even an honoured request above 2048 would be clamped back down.

Worth stressing how defect 1 hides: patching only 2 and 3 changes nothing
observable, and the device still logs `cap=2048`. What proved the patched
library was even running was the log's own line number moving from 623 to 637.

Consequence for an agent app: with a ~1200-token system prompt, deliberation
plus the answer had roughly 800 tokens. That is exactly where the thinking
overruns and mid-call truncations came from.

- Fix: `patches/engine/llamacpp-honour-context-length.patch` in this repo —
  forward `config_json` onto the session descriptor and parse it into the
  engine config, read `"context_length"` as well as `"context_size"`, and let
  an explicit request raise the cap.
- Building it: the RN packages ship prebuilt native artifacts, so the patch
  only takes effect once the engine is rebuilt.
  `scripts/engine/build-android-engine.ps1` does Android from Windows (no Mac,
  no WSL — run it from PowerShell, since MSYS mangles the CMake path
  arguments), and `.github/workflows/ios-patched-engine.yml` does iOS on the
  same macOS runner that already builds the IPA.

## 5b. Android native build script is not usable on Windows

Reproduced while trying to build the fix above with NDK 27.1 and CMake 3.30.5
installed:

- `scripts/build/build-core-android.sh` maps `uname` to an NDK host tag and
  handles only Darwin and Linux; Git Bash reports `MINGW64_NT-*` and the
  script exits. (Same root cause as finding 7.)
- It then requires `python3`, which does not exist on a standard Windows
  Python install (the binary is `python`).
- With those worked around, the NDK toolchain file's `-ffile-prefix-map`
  arguments get mangled by MSYS path conversion, and clang++ fails to
  configure.

Suggested fix: accept `MINGW*|MSYS*|CYGWIN*` as `windows-x86_64`, probe for
`python3` then `python`, and set `MSYS2_ARG_CONV_EXCL` around the CMake
invocation.

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

## 9b. React Native 0.85 release builds cannot find hermesc

`createBundleReleaseJsAndAssets` fails with "Couldn't determine Hermesc
location ... react-native/sdks/hermesc/%OS-BIN%/hermesc". RN 0.85 ships the
compiler in a separate `hermes-compiler` package
(`hermesc/win64-bin/hermesc.exe`), but the Gradle plugin still looks under
`react-native/sdks`. Worked around in this app by setting `hermesCommand` in
the `react { }` block. Affects every platform, not just Windows.

## 9c. Unused RN dependencies break Windows release builds via MAX_PATH

`react-native-gesture-handler` codegen produces object paths longer than 260
characters under `.cxx/RelWithDebInfo/...` (the debug path is short enough to
pass, so this only appears in release builds). Not an SDK bug, but worth
knowing for anyone building this stack on Windows: remove unused RN packages
or enable long paths.

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
