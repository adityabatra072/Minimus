# Minimus v1.2.0

A complete agentic AI system that runs on a phone. A 2.6B-parameter model runs
locally and drives a real agent loop: it calls tools, remembers things, learns
new commands, schedules its own future runs, sees images, and speaks. Except
for web search and any remote integrations you add, it works in airplane mode.
There is no server component.

## Voice

Tap the mic to record, tap again to stop, and the transcript is sent — no
reaching for the send button, because speaking is a hands-busy interaction and
making you reach for an arrow turns it back into a hands-on one. The transcript
renders as your turn, so a mishearing stays visible in the thread, and the
answer is spoken back.

Recording keeps every frame until you end it. An energy gate deciding when you
stopped talking is a threshold that can simply never trip — a quiet room, a
low mic gain — and then the app listens forever and writes nothing down. Only
hands-free wake mode uses endpointing, because there nobody is there to tap.

**The wake phrase is "Minimus."** Its matcher accepts the family a speech model
actually produces for a word it has never seen — minimus, minimis, minimous,
"mini mus", minimum — rather than demanding a perfect transcription.

## Taught phrases can use your own tools

A macro's steps are written in tool names, so the model can only record a step
for a tool it can see. Teaching now exposes the tools you have connected —
MCP servers, custom HTTP tools — alongside the built-ins, so "when I say
standup, post to Slack that I am running late" can actually be recorded.

Replay refuses any step whose tool needs confirmation. Macro steps execute
directly, which means they do not pass the approval card the agent loop puts
in front of anything that sends on your behalf, and a taught phrase must not
become the way around that gate.

## Also in this release

The engine patch that lets the app's requested context window through (2048 to
4096, measured on device), full tool exposure with deterministic guards instead
of keyword routing, one run lock shared by the chat screen, the rehearsal and
the scheduler, and a teaching guard that lets the model see the tools it names
in a macro's steps without being able to run them.

## Verified

- Android clean release build; the APK declares `package: name='ai.minimus.app'`
  and `application-label:'Minimus'`
- 39 harness unit tests, both routing suites clean, both typechecks green
- Agent beats 7/7 on a OnePlus 9R

## Install

**Android**: download the APK and install it. It is signed with a debug
keystore, so Play Protect will warn; that is expected for a sideloaded build.

**iOS**: the IPA is unsigned. Sign it with your own Apple ID using a
sideloading tool, or open `apps/mobile/ios` in Xcode.

First launch downloads the default model (about 1.7 GB). Voice and vision
models download on first use.
