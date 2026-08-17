/**
 * One agent generation at a time, app-wide.
 *
 * The native LLM has a single context. Two generations against it interleave
 * their KV cache and both come back damaged, so every path that can start a
 * run has to agree on one lock, not keep its own.
 *
 * This started as a module-scoped flag inside ChatScreen (screen switches
 * unmount it, and a component-local ref forgets an in-flight run, so QA caught
 * two generations overlapping by 191s and 117s). That flag covered the chat
 * screen only. Watching a rehearsal, a scheduled task came due mid-beat and
 * started a second generation 1.5 seconds into the first — same failure, a
 * path the flag never saw:
 *
 *   10:22:19 generate start promptChars=5074   <- rehearsal wrap-up turn
 *   10:22:20 generate start promptChars=5467   <- scheduled task waking up
 *
 * The lock is deliberately not a queue. A scheduled task that arrives busy
 * stays pending and fires on the next tick, which is the right behaviour for
 * something already asynchronous; a foreground run that arrives busy is a
 * double tap and should be dropped.
 */

let held = false;

export function isRunBusy(): boolean {
  return held;
}

/** Returns false when a run is already in flight. */
export function acquireRun(): boolean {
  if (held) return false;
  held = true;
  return true;
}

export function releaseRun(): void {
  held = false;
}
