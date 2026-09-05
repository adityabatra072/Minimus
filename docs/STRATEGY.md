# Where Minimus wins

A working note, not marketing. What would make a real person open this every
day, where Apple is heading, and where a small model on the phone beats a
large one in the cloud.

## 1. The one thing a person does every day

The candidates, tried against the question "would I actually do this
tomorrow morning?":

| Habit | Why it sticks | Why others fail at it |
| --- | --- | --- |
| **Say it, done** (flashlight, timer, alarm, brightness, "remind me", "text Mum I'm late") | Zero seconds of thought, no app-hunting, works on the lock screen through "Talk to Minimus". Reflexes make the common ones instant (0.2 s). | Siri does some of these but not "wind down" style taught routines, and it forgets what you taught it. |
| **Teach it a phrase once** ("when I say wind down: dim to 20%, DND, play rain, alarm 6:45") | Personal automation without opening Shortcuts. Taught routines run as reflexes forever after. | Shortcuts is a programming tool; nobody's parents use it. |
| **Morning brief** (calendar, reminders, alarms, scheduled tasks, in your own context) | One spoken paragraph at a fixed time replaces three app checks. It's recurring, so the habit forms itself. | Siri/Google have this only as a widget grid; not spoken, not personal, no memory of what you told it yesterday. |
| **Remember this** ("locker code is 4417", "Sam's kid is called Ivy") and recall by asking | Private, on-device, instant recall, stated back in plain words. | Notes apps make you find it later. Cloud assistants make you trust them with it. |
| **Later, on its own** ("in 20 minutes check if it's still raining and tell me") | The agent acts later with every tool, not just a bell. | Nothing on a phone does this without a subscription cloud agent. |

Recommendation: lead with **Say it, done + taught phrases**, and make the
**morning brief** the retention hook. All three are shipped in v2.1. The
brief is one Settings toggle; it should move to onboarding ("want a
brief each morning? pick a time") so it is on by default for people who
say yes.

## 2. Apple Intelligence and the Siri hybrid, in one paragraph

Apple's path: an on-device ~3B model for classification, summaries and
Writing Tools, Private Cloud Compute for bigger asks, and (per the 2026
roadmap) a Gemini-based Siri for open-ended questions. App Intents are the
interface: apps declare what they can do, Siri learns to call them. It's
excellent at *system* things and at *Apple's* apps. It is deliberately not
programmable by the user, has no persistent memory you can inspect, does not
let you bring your own model, and the agentic part (multi-step, act later,
chain across apps) is the slowest to arrive because Apple must make it
safe for a billion people at once.

## 3. How a small on-device model beats that

Not by being smarter than Gemini. By being **yours**, **fast**, and
**willing to act**.

1. **Teachable.** Taught phrases and memory are files on the phone that you
   can read, edit and delete (Memory screen). Apple won't ship "teach Siri a
   routine by saying it" because it can't audit a billion routines. We can,
   because it's one phone.
2. **Acts later, with tools.** `schedule_task` wakes the agent with every tool
   and the instruction. A 2.6B model is plenty for "check the weather tool,
   compare with what I said, notify me". Apple's model cannot be scheduled
   by the user at all.
3. **Reflexes + router.** The 200 ms path for common phrases and a grammar-
   constrained router that hides tools the message can't need make a small
   model feel like a big one: most turns never see a tool list. This is a
   *harness* advantage, which is why the harness is the product.
4. **Bring your own brain.** Swap the GGUF; point at a laptop `llama-server`
   or any OpenAI-compatible endpoint for the hard turns; cloud voice
   endpoints when you want them. Apple decides your model for you.
5. **Private by construction.** No account, no telemetry, the model file is on
   disk. This is a feature people pay for after the first cloud-assistant
   headline.
6. **Cross-platform.** Same JS on Android. Apple never will be.

### Beyond MCP: controlling the things around you

MCP is table stakes; Minimus already speaks it (`services/mcp.ts`). The
differentiator is what a *phone* can reach that a laptop agent can't:

- **Bluetooth and local network.** HomeKit (via Shortcuts on iOS, HomeAssistant
  MCP everywhere), Matter devices, a Sonos on the LAN, the car's BLE profile.
  A small model deciding "lights 20%, rain sounds, lock the door" locally is
  exactly the right size of intelligence for a smart home and it works when
  the internet is down.
- **The camera as a sensor.** SmolVLM is wired for "what's this?"; the next
  step is "read this receipt into memory", "what's the Wi‑Fi password on this
  router label", "remember this parking spot" (photo + location).
- **Share sheet in.** Anything you can share becomes "remember this" or
  "summarise this" without leaving the app you're in.
- **Hands and ears.** "Talk to Minimus" from the Action button turns the phone
  into a walkie-talkie for your digital life, which is the interaction Siri
  promised in 2011.

What not to chase: web browsing agents, long documents, coding. Big models
and big screens win there.

## 4. The next three things, in order

1. **Onboarding asks about the morning brief** and offers to learn one
   phrase. Retention starts on day one.
2. **Share extension** ("Remember with Minimus") on iOS; `ACTION_SEND` on
   Android.
3. **Home control via HomeAssistant MCP + Shortcuts run**, so "wind down" can
   include the lights.

## 5. Honest constraints

- iPhone 15 throttles a sustained 2.6B decode from ~25 to ~5 tok/s within
  minutes; the thermal-aware budget helps but physics wins. Turns must stay
  short, which the router and reflexes already enforce.
- AlarmKit needs iOS 26. On 17.5–18 alarms are notifications. Say so in the
  UI (the Clock screen does).
- On-device STT is good, not perfect. The LLM correction pass and the
  vocabulary boost close most of the gap; cloud STT is one toggle away.
