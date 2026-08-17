/**
 * Deterministic pre-routing for the agent prompt.
 *
 * Why this exists: on-device generation budgets are tight — the C++ layer
 * accounts generation against a ~2048-token window, so a system prompt
 * carrying all 16 tool schemas leaves a deliberation-heavy model almost no
 * room to think. On the iPhone rehearsal this showed up as "got no tools"
 * (thinking overrun) on exactly the beats that need deliberation. Exposing
 * only the relevant tool groups halves the prompt and restores the budget —
 * the same conditions the eval rig validates under.
 *
 * Routing is keyword-based and additive; unmatched prompts get the broad
 * default set. 'core' (memory + macros) is routed like everything else —
 * it used to ride along unconditionally, and those four extra schemas were
 * the difference between calendar-judgment passing 4/4 (rehearsal,
 * schedule-only) and stalling 0/3 in chat on the same phone.
 */

const GROUP_TRIGGERS: [RegExp, string][] = [
  [/\b(play|song|music|spotify|album|playlist|track)\b/i, 'music'],
  [/\b(search|google|look up|latest|news|web|website|internet|find out|who is|what is)\b/i, 'web'],
  [/\b(email|mail|text|sms|message|call|dial|phone)\b/i, 'comms'],
  [
    /\b(calendar|meeting|event|schedule|remind|reminder|alarm|timer|tomorrow|tonight|later|minutes?|hours?|gym|appointment|notify)\b/i,
    'schedule',
  ],
  [
    /\b(flashlight|torch|brightness|battery|storage|open|launch|clipboard|copy|screen|dim)\b/i,
    'device',
  ],
  [
    /\b(remember|recall|forget|memory|what did i|what do i need|i told you|note that|save this)\b/i,
    'core',
  ],
];

const DEFAULT_GROUPS = ['device', 'schedule', 'music'];

export function routeToolGroups(prompt: string, macroNames: string[] = []): string[] {
  const groups = new Set<string>();
  for (const [re, group] of GROUP_TRIGGERS) {
    if (re.test(prompt)) groups.add(group);
  }
  // Teaching a phrase or saying a taught one needs the macro tools (group
  // 'core'), whatever the rest of the sentence looks like.
  const lower = prompt.toLowerCase();
  if (TEACHING_RE.test(prompt) || macroNames.some((n) => lower.includes(n.toLowerCase()))) {
    groups.add('core');
  }
  if (groups.size === 0) for (const g of DEFAULT_GROUPS) groups.add(g);
  return [...groups];
}

const TEACHING_RE = /\b(new rule|when(ever)? i say|teach you|from now on,? when)\b/i;

// Deliberately narrow: "in/after N minutes" is a deferred AGENT action, while
// "tomorrow"/"tonight" phrasings are usually calendar territory — injecting a
// schedule_task hint there would re-blur the schedule_task≠calendar_create
// boundary the tool descriptions fight to keep sharp.
const DEFERRED_RE = /\b(in|after) \d+ (seconds?|minutes?|hours?)\b/i;

/**
 * "Do X, then in N minutes do Y" — the deferred half must become a
 * schedule_task, but small models reliably reach for set_timer (a timer
 * "feels" like waiting). Rig evidence: watchdog-arm is flaky without this
 * line even at full output budget. Same proven pattern as teachingPreamble.
 */
export function deferredPreamble(prompt: string): string | null {
  if (!DEFERRED_RE.test(prompt)) return null;
  return (
    'Part of this request happens LATER. Do the immediate part now with tools, ' +
    'then hand the later part to schedule_task (instruction = what to do, when = when) — ' +
    'schedule_task runs YOU again at that time to do it. After handing it off, give your short final answer.'
  );
}

/**
 * Rig evidence (watchdog-arm, 6 repeats): even WITH the preamble above the
 * model grabs set_timer ~1 run in 3 — "wait 3 minutes" feels like a timer.
 * Prompt persuasion caps out; hiding the tool is deterministic. The narrow
 * DEFERRED_RE keeps real timer requests ("set a timer for 10 minutes",
 * phrased with "for") unaffected.
 */
export function deferredToolExclusions(prompt: string): string[] {
  return DEFERRED_RE.test(prompt) ? ['set_timer', 'set_alarm'] : [];
}

/**
 * The user said a phrase they taught ("Wind down.") — the only right move is
 * run_macro, but with define_macro visible the model sometimes re-defines the
 * macro from scratch instead (seen on the rig). Hide define_macro and say
 * which macro matched. Never fires while the user is TEACHING (that path
 * needs define_macro).
 */
export function macroSteering(
  prompt: string,
  macroNames: string[],
): { exclude: string[]; line: string } | null {
  if (TEACHING_RE.test(prompt)) return null;
  const lower = prompt.toLowerCase();
  const match = macroNames.find((n) => lower.includes(n.toLowerCase()));
  if (!match) return null;
  return {
    exclude: ['define_macro'],
    line: `The user just said the taught phrase "${match}". Call run_macro with name "${match}" — do not do anything else first.`,
  };
}

/**
 * A sentence full of imperatives ("set…", "turn off…") makes a small model
 * act instead of record. When the user is clearly teaching a phrase, say so
 * up front — validated on the rig: without this line teach-beats fail, with
 * it they pass consistently.
 */
export function teachingPreamble(prompt: string): string | null {
  if (!TEACHING_RE.test(prompt)) return null;
  return (
    'The user is TEACHING you a phrase, not asking you to act. You MUST call ' +
    'define_macro exactly once, with the phrase as `name` and every action as a ' +
    'step in `steps`. Do NOT perform any of the actions now.'
  );
}

/**
 * Rig evidence (teach-devstate, 0/3): re-teaching a phrase that is already in
 * the taught-phrases list makes the model act AND define across 5-8 turns —
 * the list line says "call run_macro for this phrase" while the teaching line
 * says "only define_macro". While teaching: the list line must be dropped
 * from the preamble (callers check isTeaching) and run_macro hidden.
 */
export function isTeaching(prompt: string): boolean {
  return TEACHING_RE.test(prompt);
}

export function teachingToolExclusions(prompt: string): string[] {
  // `remember` is the other trap: teaching a phrase looks enough like storing
  // a fact that the model writes the rule to memory and reports success
  // without ever defining the macro (device evidence: remember(fact='When
  // user says "wind down", set brightness to 20 percent...')). While the user
  // is TEACHING, neither replaying nor remembering can be the right call.
  return TEACHING_RE.test(prompt) ? ['run_macro', 'remember'] : [];
}
