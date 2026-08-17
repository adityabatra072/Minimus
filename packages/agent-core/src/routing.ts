/**
 * Deterministic pre-routing for the agent prompt.
 *
 * READ THIS FIRST: keyword routing is NO LONGER the default. It exists for a
 * model loaded in a small context window, and nothing else.
 *
 * It was written when every model loaded at 2048 tokens (docs/SDK-FINDINGS.md
 * §5) and the full tool set cost 1261 of them. Under that pressure, showing
 * the model only the relevant groups was the difference between working and
 * stalling. But keyword matching decides what the model is ALLOWED to do from
 * the words the user happened to use, and it is wrong constantly once you
 * leave the demo script: "How much space have I got left on this phone?"
 * routed to `comms`, because "phone" is a comms trigger, so device_info was
 * never on the table. Measured on suites/general.yaml, 7 of 16 ordinary
 * requests never saw the tool they needed — a failure the model cannot
 * recover from, because you cannot call a tool you were not given.
 *
 * With the engine patched to honour the requested context window, the full
 * set fits, so composeRun exposes everything by default and the model gets to
 * decide. Narrow exposure stays available (`narrowExposure: true`) for a
 * small window, where a wrong guess still beats no room to think.
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
    'then hand the later part to schedule_task (instruction = what to do, when = "+N" minutes from now) — ' +
    'schedule_task runs YOU again at that time to do it. Give `when` as a relative offset like "+3", ' +
    'never an absolute clock time: your own thinking takes minutes, so a timestamp you compute now is ' +
    'already stale by the time the tool runs. After handing it off, give your short final answer.'
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

/**
 * Every group except `vision`, which is attachment-gated (describe_image with
 * no image attached is a tool that can only be called wrongly).
 */
export const ALL_TOOL_GROUPS = ['core', 'device', 'schedule', 'web', 'comms', 'music'];

export interface ComposeOptions {
  /** Phrases the user has taught, by name. */
  macroNames?: string[];
  /**
   * Route by keyword instead of exposing every group. Only for a model
   * loaded in a small context window — see the note on routeToolGroups.
   */
  narrowExposure?: boolean;
  /** 'scheduled' when the agent woke itself for a task it queued earlier. */
  origin?: 'user' | 'scheduled';
  hasAttachment?: boolean;
  /** User-opted-in tools (custom HTTP, MCP) — always exposed. */
  extraToolGroups?: string[];
  /** Built-ins the user switched off in Tools. */
  extraExcludeTools?: string[];
}

export interface RunComposition {
  toolGroups: string[];
  excludeTools: string[];
  preamble: string;
}

export const BASE_PREAMBLE =
  'You are Minimus, running entirely on this phone. You get things DONE using tools, then confirm briefly.';

/**
 * Compose the tool exposure and system preamble for one run.
 *
 * This is THE composition — the chat screen, the headless scheduled runner and
 * the eval rig all call it. It used to live inline in ChatScreen with the rig
 * re-stating each rule in YAML, which meant the rig measured a agent we
 * believed in rather than the one that shipped, and every routing change had
 * to be mirrored by hand in two places. Anything that changes what the model
 * sees belongs here.
 */
export function composeRun(prompt: string, opts: ComposeOptions = {}): RunComposition {
  const macroNames = opts.macroNames ?? [];
  const lines = [BASE_PREAMBLE];

  // While TEACHING, the taught-phrases line is poison: it says "call run_macro
  // for this phrase" while the teaching line says "only define_macro" — the
  // model then acts AND defines across 5-8 turns (rig: teach-devstate 0/3
  // with the line, clean without).
  if (macroNames.length > 0 && !isTeaching(prompt)) {
    lines.push(
      `Phrases the user has taught you (run these with run_macro): ${macroNames
        .map((n) => `"${n}"`)
        .join(', ')}. If the user says one of them, call run_macro with that name.`,
    );
  }
  if (opts.origin === 'scheduled') {
    lines.push(
      'This is a task you scheduled earlier and it is now due. Carry it out with your tools, then state the outcome in one short sentence.',
    );
  }
  const teaching = teachingPreamble(prompt);
  if (teaching) lines.push(teaching);
  const deferred = deferredPreamble(prompt);
  if (deferred) lines.push(deferred);
  const macroHit = macroSteering(prompt, macroNames);
  if (macroHit) lines.push(macroHit.line);
  if (opts.hasAttachment) {
    lines.push(
      'The user attached an image to this message. Call describe_image to see it before answering anything about it.',
    );
  }

  return {
    toolGroups: [
      ...(opts.narrowExposure ? routeToolGroups(prompt, macroNames) : ALL_TOOL_GROUPS),
      ...(opts.extraToolGroups ?? []),
      ...(opts.hasAttachment ? ['vision'] : []),
    ],
    excludeTools: [
      ...deferredToolExclusions(prompt),
      ...teachingToolExclusions(prompt),
      ...(macroHit?.exclude ?? []),
      ...(opts.extraExcludeTools ?? []),
    ],
    preamble: lines.join('\n'),
  };
}

export function teachingToolExclusions(prompt: string): string[] {
  // `remember` is the other trap: teaching a phrase looks enough like storing
  // a fact that the model writes the rule to memory and reports success
  // without ever defining the macro (device evidence: remember(fact='When
  // user says "wind down", set brightness to 20 percent...')). While the user
  // is TEACHING, neither replaying nor remembering can be the right call.
  return TEACHING_RE.test(prompt) ? ['run_macro', 'remember'] : [];
}
