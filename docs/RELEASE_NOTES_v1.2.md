# Minimus v1.2.0

The app is now **Minimus**. Same agent, real name, production identifiers.

A complete agentic AI system that runs on a phone. A 2.6B-parameter model runs
locally and drives a real agent loop: it calls tools, remembers things, learns
new commands, schedules its own future runs, sees images, and speaks. Except
for web search and any remote integrations you add, it works in airplane mode.
There is no server component.

## Renamed

Minimus is the product; RunAnywhere is the SDK it is built on, and that
distinction now holds everywhere. The display name, wordmark, npm scope
(`@minimus/*`), log prefix, storage keys, native module (`MinimusTools`) and
the voice wake phrase all say Minimus. `@runanywhere/*` and the SDK credit stay
exactly where they belong.

**The wake phrase is "Minimus."** Its matcher accepts the family a speech model
actually produces for a word it has never seen — minimus, minimis, minimous,
"mini mus", minimum — rather than demanding a perfect transcription.

## Production identifiers

Two identifiers were still React Native template placeholders:

```
applicationId "com.mobile"
PRODUCT_BUNDLE_IDENTIFIER = "org.reactjs.native.example.$(PRODUCT_NAME...)"
```

Both are now `ai.minimus.app`. The Android sources moved out of
`com.mobile` into a real package, and `CFBundleName` was `$(PRODUCT_NAME)`, so
iOS Settings would have listed the app as "mobile" — it is set explicitly now.

**This installs as a new app.** Because the bundle identifier changed, delete
any previous build first: memories, taught phrases and scheduled tasks from it
do not carry over.

## Voice actually works

Tap the mic to record, tap again to stop, and the transcript is sent — no
reaching for the send button, because speaking is a hands-busy interaction.

Before, tapping a second time called stop, which halted capture and **threw the
audio away**. The only path that ever produced a transcript was an energy-based
endpointer closing the utterance for you, so if the level gate never tripped
the app sat on "listening" forever and nothing was ever written down. Recording
now keeps every frame until you end it. Hands-free wake mode keeps the
endpointer, since nobody is there to tap.

## Also in this release

Everything from v1.1.0: the engine patch that lets the app's requested context
window through (2048 to 4096, measured on device), full tool exposure with
deterministic guards instead of keyword routing, one run lock across chat,
rehearsal and the scheduler, and the teaching guard that lets the model see the
tools it names in a macro's steps without being able to run them.

## Verified

- Android clean release build from scratch on the new package; the APK itself
  declares `package: name='ai.minimus.app'` and
  `application-label:'Minimus'`
- 39 harness unit tests, both routing suites clean, both typechecks green
- Agent beats 7/7 on a OnePlus 9R (v1.1.0 build, unchanged agent behaviour)

## Install

**Android**: download the APK and install it. It is signed with a debug
keystore, so Play Protect will warn; that is expected for a sideloaded build.

**iOS**: the IPA is unsigned. Sign it with your own Apple ID using a
sideloading tool, or open `apps/mobile/ios` in Xcode.

First launch downloads the default model (about 1.7 GB). Voice and vision
models download on first use.
