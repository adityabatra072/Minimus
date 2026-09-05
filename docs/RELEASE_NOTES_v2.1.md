# Minimus v2.1

The release where the phone becomes something you talk to.

## Nothing left of RunAnywhere

Voice was the last thing on the RunAnywhere SDK. It is gone from the app,
the Podfile, the lockfile and the postinstall script. Hearing is Apple's
on-device recognizer with the app's vocabulary boosted (taught phrases, "new
rule", tool words) and a short language-model pass that repairs misheard
words. Speaking is the system voice, with a picker and speed in Settings, or
an OpenAI-compatible cloud speech endpoint. Cloud transcription is a toggle
too. No voice models to download.

## Real alarms

`set_alarm` and `set_timer` now go through AlarmKit on iOS 26: lock-screen
alerts that keep ringing, a countdown Live Activity, snooze. On older iOS
they fall back to notifications and the app says so. New Clock screen with
alarms, timers (pause/resume, progress) and a stopwatch; a header pill shows
the soonest timer or next alarm; a finished timer drops a line into the
chat. "Wake me at 6:45" and "alarm at 7 every day" are reflexes.

## Lower resistance

- "Hey Siri, ask Minimus to …" and "Talk to Minimus" (App Intents / App
  Shortcuts). The second opens the app listening and speaks the answer.
- Both appear in Shortcuts, so they go on the Action button, Back Tap, and
  Focus automations.
- Push-to-talk shows live words in the composer while you speak.

## Something to come back for

- Morning brief: pick a time in Settings and a recurring scheduled task
  gathers calendar, reminders, alarms and scheduled tasks (`daily_brief`)
  and tells you about your day in your own context.
- `schedule_task` can repeat daily.

## Fixes

- The app opens to a new chat; older chats reopened from History feed their
  transcript back to the model as prior turns.
- Live text repaints at 200 ms instead of per token; the 2.6B thinking budget
  and answer length are lower. Less heat, same scores on the rig.

## For Android

`docs/ANDROID-HANDOFF.md` lists every native method and behaviour needed for
parity. `docs/STRATEGY.md` is the product note: the daily habit, the Apple
comparison, where a small on-device model wins.
