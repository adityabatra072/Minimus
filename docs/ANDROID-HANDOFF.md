# Android handoff: reaching iOS parity

Minimus on iOS is at v2.1. The Android app has not moved since v1.x. This is
the list of everything the Android build needs so that the same JavaScript
runs unchanged on both. The JavaScript side (`apps/mobile/src`, `packages/`)
is shared and already written; almost all of the work here is Kotlin plus
build wiring.

Written 2026-09-05. Repository state: `main` after the v2.1 push.

## 0. Ground rules

- The JS never branches on platform for features. It checks `NativeModules.X`
  for presence and adapts. So each native module below must be registered
  under the **same module name** and expose the **same method signatures**,
  returning the **same shapes**. Where a method returns a promise on iOS it
  must on Android too.
- Anything that cannot exist on Android (AlarmKit) has a documented fallback
  in JS; you implement the fallback's native half.
- Test on a real phone. Thermal and speed numbers on an emulator mean nothing.

## 1. Inference: llama.rn on Android

iOS dropped RunAnywhere entirely. `llama.rn` (0.13.0-rc.2) is the only
inference dependency now. Android:

- `llama.rn` ships Android prebuilds (arm64-v8a, with OpenCL/Vulkan variants
  in recent versions). Add nothing to the Podfile equivalent; just make sure
  autolinking picks it up (`android/settings.gradle` uses RN autolinking).
- `initLlama` params come from `services/engine.ts` and are platform neutral:
  `n_ctx 8192, n_gpu_layers 99, flash_attn_type 'auto', state_cache_budget_mb
  200, ctx_shift false`. On Android `n_gpu_layers 99` only means something
  when the GPU backend is compiled in; measure both. Expect CPU decode of
  the 2.6B Q4_0 at 8 to 15 tok/s on a Snapdragon 8 Gen 2, prefill 100 to
  200 tok/s. If it is far under that, check that the arm64 build uses
  `-march=armv8.2-a+dotprod+i8mm`.
- The **router lane** (`engine.routerContext()`) opens a second context on the
  same GGUF. On Android this is a second mmap of the same file; the weights
  are shared by the kernel, so memory does not double. Keep it.
- Prompt-state checkpoints: llama.rn saves them per context; the app relies on
  the system prompt being constant per session (see `docs/HOW-IT-WORKS.md`,
  "why the system prompt never changes"). Nothing to do, but do not "improve"
  this by varying the system prompt on Android.
- `releaseAllLlama()` is called on JS reload in `__DEV__` to stop leaked
  contexts. Same on Android.
- Vision (`services/vision.ts`) uses llama.rn's `mtmd` multimodal path with
  SmolVLM. Works on Android with the same calls; the projector file downloads
  alongside the model.

Model files live in `RNFS.DocumentDirectoryPath/models` (`services/models.ts`,
`MODELS_DIR`). `adoptLegacyModels()` moves files from the old RunAnywhere
directory; on Android that old path is under `filesDir/runanywhere` if the
user ever had v1 installed. Point `LEGACY_DIRS` at it.

## 2. Native module `MinimusTools` (Kotlin)

Package: `ai.minimus.app`. One `ReactContextBaseJavaModule` named
`MinimusTools`. The iOS implementation is `ios/MinimusTools/MinimusTools.m`;
match it method for method. Every method returns a Promise.

| Method | Android implementation |
| --- | --- |
| `torch(on: boolean)` | `CameraManager.setTorchMode(id, on)` on the first back camera with flash. |
| `setBrightness(level 0..1)` | `Settings.System.SCREEN_BRIGHTNESS` needs `WRITE_SETTINGS` (user grants via intent); fall back to window brightness for the app only. Return which one you did. |
| `keepAwake(on)` | `FLAG_KEEP_SCREEN_ON` on the current activity window. |
| `notify(title, body)` | `NotificationManagerCompat` on a channel `minimus.general`; request `POST_NOTIFICATIONS` (API 33+). |
| `notifyAt(atMillis, title, body, identifier)` → string | `AlarmManager.setExactAndAllowWhileIdle` + a `BroadcastReceiver` that posts the notification; needs `SCHEDULE_EXACT_ALARM` / `USE_EXACT_ALARM`. Return the identifier. |
| `cancelNotification(identifier)` | Cancel the pending intent and any posted notification with that id. |
| `setTimer(seconds, label)` | Fallback path only (see AlarmKit below): `AlarmManager` exact alarm + full-screen-intent notification with sound on channel `minimus.alarm` (IMPORTANCE_HIGH, alarm audio attributes). |
| `setAlarm(hour, minute, label)` | Same receiver, `Calendar` for next occurrence. Optionally also fire `AlarmClock.ACTION_SET_ALARM` with `EXTRA_SKIP_UI` so the system Clock app owns it (this is the closest Android has to AlarmKit; prefer it when `EXTRA_SKIP_UI` is honoured). |
| `calendarInsert(title, startMillis, durationMinutes, notes)` → id or null | `CalendarContract.Events` insert with `WRITE_CALENDAR`; or `Intent(ACTION_INSERT)` when permission is denied (return null so JS reports "opened in calendar"). |
| `calendarQuery(startMillis, endMillis)` → `[{title,startMillis,endMillis}]` | `CalendarContract.Instances` query, `READ_CALENDAR`. |
| `clipboardRead()` / `clipboardWrite(text)` | `ClipboardManager`. |
| `contactsSearch(query)` → `[{name, phone, email}]` | `ContactsContract` with `READ_CONTACTS`; match display name prefix and word starts, cap at 10. |
| `reminderCreate(title, dueMillis, notes)` → id | No Reminders app on Android. Insert a `CalendarContract.Events` all-day event with `hasAlarm`, or a `Tasks`-provider row if Google Tasks is present. Return an id; JS says "reminder added". |
| `deviceHealth()` → `{thermal, footprintMb, batteryPct, charging, lowPower}` | `PowerManager.getCurrentThermalStatus()` mapped to `nominal/fair/serious/critical`; `Debug.getPss()` for footprint; `BatteryManager` for the rest. The loop shrinks thinking budgets on `serious`/`critical`, so the mapping matters. |
| `requestNotificationPermission()` | `POST_NOTIFICATIONS` runtime request. |

Also register these in `AndroidManifest.xml`: the receiver for exact alarms,
`RECEIVE_BOOT_COMPLETED` so pending alarms survive a reboot (re-arm from a
persisted list), and `FOREGROUND_SERVICE` only if you later run inference
in the background.

## 3. Native module `MinimusAlarms` (Kotlin) — the clock

iOS 26 uses AlarmKit for Clock-app-grade alarms and timers with Live
Activities. Android has no equivalent API, but the Clock app and `AlarmManager`
together cover it. The JS store (`services/clock.ts`) calls:

| Method | Android |
| --- | --- |
| `alarmAuthorization()` → `'authorized'|'denied'|'unavailable'` | Return `'authorized'` when `canScheduleExactAlarms()` is true, else prompt via `ACTION_REQUEST_SCHEDULE_EXACT_ALARM` and return the result. |
| `alarmSchedule(hour, minute, label, repeatsDaily)` → id | Exact alarm + full-screen intent activity (`AlarmActivity`) that plays the alarm ringtone with `USAGE_ALARM`, shows Stop/Snooze, and for `repeatsDaily` re-arms itself. Persist `{id, hour, minute, label, repeats}` in SharedPreferences so `alarmList` and boot re-arm work. |
| `timerStart(seconds, label)` → id | Exact alarm at now+seconds; an ongoing notification with a chronometer (`setUsesChronometer`, `setChronometerCountDown(true)`) is the countdown surface (this is what the Clock app does). |
| `alarmList()` → `[{id, state, kind, fireAtMs, hour?, minute?, durationSeconds?}]` | From the persisted list; `state` is `scheduled`, `countdown`, `paused`, or `alerting`. |
| `alarmCancel/alarmStop/alarmPause/alarmResume(id)` | Cancel the pending intent; for pause record remaining seconds and cancel; resume re-arms. |
| `speakSystem(text, rate, voiceId)` | `TextToSpeech` with `UtteranceProgressListener`; resolve on done. `systemVoices()` maps `tts.voices` to `{id, name, language, quality}` where `quality` is `premium/enhanced/default` from `Voice.getQuality()`. |
| `stopSystemSpeech()` | `tts.stop()`. |
| `playAudioFile(path)` / `stopAudio()` | `MediaPlayer`. Used for cloud TTS mp3. |
| `remindersList(withinHours)` → `[{title, dueAtMs?, list?}]` | Return `[]` unless you implemented reminders via a provider. |

JS behaviour to preserve: `clock.ts` reconciles its own list with
`alarmList()` every few seconds; a timer that disappears from the native list
is treated as done. Make sure a stopped timer really leaves the list.

## 4. Native module `MinimusSpeech` (Kotlin) — hearing

iOS uses `SFSpeechRecognizer` on-device with `contextualStrings`. Android
equivalent: `SpeechRecognizer` with `EXTRA_PREFER_OFFLINE` and (API 33+)
`EXTRA_ENABLE_LANGUAGE_DETECTION` off, `EXTRA_PARTIAL_RESULTS` on. There is
no contextual-strings API on Android; the LLM correction pass in
`services/voice.ts` (`correctTranscript`) still runs, and it carries the
vocabulary, so recognition quality gap is smaller than it looks.

It is a `ReactContextBaseJavaModule` that emits events through
`DeviceEventManagerModule.RCTDeviceEventEmitter`:

- `speechAuthorization()` → `{speech: 'authorized'|'denied', microphone: bool, onDevice: bool, available: bool}` (`RECORD_AUDIO`).
- `speechStart(contextualStrings: string[], onDevice: bool, recordPath: string)`: start `SpeechRecognizer`; emit `MinimusSpeech {text, isFinal}` on partial and final results and `MinimusSpeechLevel {level}` from `onRmsChanged` (normalise dB to 0..1). If `recordPath` is non-empty also record 16 kHz mono PCM WAV with `AudioRecord` (cloud STT uploads this file).
- `speechStop()` → final text (resolve within 2 s even if the recogniser is slow; return the last partial).
- `speechCancel()`.

Android's `SpeechRecognizer` stops itself after silence. The JS hands-free
endpointing (1.4 s of unchanged transcript) still works; just make sure you
emit a final result rather than an error when the recogniser ends on its own
(`ERROR_SPEECH_TIMEOUT` should resolve with the last partial, not reject).

## 5. Deep links and App Intents equivalents

- `minimus://ask?q=…` and `minimus://ask?listen=1` are handled in
  `ChatScreen.tsx` through `Linking`. Add an `intent-filter` for scheme
  `minimus` on `MainActivity` (`launchMode="singleTask"`).
- Siri/App Intents equivalent: an `App Actions` / Assistant shortcut is not
  worth it. Instead ship (a) a home-screen **widget** with a mic button that
  fires `minimus://ask?listen=1`, (b) a **Quick Settings tile**
  (`TileService`) that does the same, and (c) support `ACTION_ASSIST` /
  `android.intent.action.VOICE_COMMAND` so the user can set Minimus as the
  assist app (long-press power / swipe gesture). That gives Android the
  "call on speaker" path iOS gets from "Talk to Minimus".
- Share sheet: an `ACTION_SEND` filter for `text/plain` that opens
  `minimus://ask?q=remember this: <text>`. (iOS gets this via a Share
  Extension in a later release; land it on Android first if it is easy.)

## 6. App identity and assets

- Application id `ai.minimus.app`, name "Minimus".
- Icon: regenerate adaptive icons from `ios/mobile/Images.xcassets/AppIcon`
  (the source is a 1024 px PNG). Foreground = mark, background = paper
  `#F4F1EA` (see `theme.ts`, `light.bg`).
- Splash: match `LaunchScreen.storyboard` (paper background, centered mark).
- Permissions strings live in the manifest; copy the tone of the iOS
  `Info.plist` usage descriptions.
- Privacy: no network by default except model downloads and user-configured
  endpoints; document that in the Play data-safety form.

## 7. QA on Android

The laptop QA bridge (`scripts/qa/qa.mjs serve`, app side `services/qaBridge.ts`)
is platform-neutral: the app polls `http://<laptop>:8787`. For Android:

- `adb reverse tcp:8787 tcp:8787` and set the bridge host to `127.0.0.1`
  (write `qa-host.txt` into the app files dir with `adb push`, or set it in
  Diagnostics).
- Add `scripts/android/device.sh build|install|launch|all` mirroring
  `scripts/ios/device.sh` (gradle `assembleDebug`, `adb install -r`,
  `adb shell am start`).
- Then `scripts/qa/seq.sh "hello" "turn on the flashlight" "wake me at 6:45"`
  and the deep checks (`node scripts/qa/qa.mjs deep`) should pass. The
  scorecard to beat is in `docs/QA.md`.

## 8. Things that are already done for you

- Everything under `packages/` (agent loop, router, reflexes, prompts, eval).
- All screens and stores under `apps/mobile/src`.
- Tool registration checks `NativeModules.MinimusTools` and skips schedule
  tools if it is missing, so the app runs (without alarms) before section 2
  is finished. Ship section 1 first, then 2, then 4, then 3.

## 9. Known differences to accept

- No AlarmKit Live Activity: the timer countdown is an ongoing notification.
- No `contextualStrings`: rely on the LLM correction pass.
- Reminders: no system Reminders app; use calendar or Tasks provider.
- Thermal behaviour differs by SoC; keep the same budget-shrinking policy.
