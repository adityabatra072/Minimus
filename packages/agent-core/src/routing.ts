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

import { categoriesToGroups, type RouterCategory } from './router.js';

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
    'memory',
  ],
];

const DEFAULT_GROUPS = ['device', 'schedule', 'music'];

/**
 * A taught phrase counts as SAID only as a whole phrase on word boundaries.
 * Substring matching made a phrase called "hi" fire on "this", and "hello"
 * after teaching anything ran the macro (device evidence from user testing).
 */
export function saidPhrase(prompt: string, macroNames: string[]): string | null {
  const lower = ` ${prompt.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
  for (const name of macroNames) {
    const n = name.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (n && lower.includes(` ${n} `)) return name;
  }
  return null;
}

export function routeToolGroups(prompt: string, macroNames: string[] = []): string[] {
  const groups = new Set<string>();
  for (const [re, group] of GROUP_TRIGGERS) {
    if (re.test(prompt)) groups.add(group);
  }
  // Teaching a phrase or saying a taught one needs the macro tools (group
  // 'core'), whatever the rest of the sentence looks like.
  if (isTeaching(prompt) || saidPhrase(prompt, macroNames)) {
    groups.add('macro');
  }
  if (groups.size === 0) for (const g of DEFAULT_GROUPS) groups.add(g);
  return [...groups];
}

// Paraphrases seen on the rig: "If I ever ask for focus mode, …", "Make me a
// shortcut called bedtime that …". Both are the user teaching a phrase.
const TEACHING_RE =
  /\b(new rule|when(ever)? i (say|ask for|tell you)|if i (ever )?(say|ask for|tell you)|teach you|from now on,? (when|if)|(make|create|add|set up) (me )?an? (shortcut|macro|routine|command|phrase) (called|named|for))\b/i;

// Deliberately narrow: "in/after N minutes" is a deferred AGENT action, while
// "tomorrow"/"tonight" phrasings are usually calendar territory — injecting a
// schedule_task hint there would re-blur the schedule_task≠calendar_create
// boundary the tool descriptions fight to keep sharp.
const DEFERRED_RE =
  /\b(in|after) \d+ (seconds?|minutes?|hours?)\b|\b(tonight|tomorrow|later|this (evening|afternoon)|at \d{1,2}(:\d{2})?\s?([ap]m)?)\b[^.]*\b(check|tell me|see if|let me know|look at|compare|report)\b/i;

/**
 * "Do X, then in N minutes do Y" — the deferred half must become a
 * schedule_task, but small models reliably reach for set_timer (a timer
 * "feels" like waiting). Rig evidence: watchdog-arm is flaky without this
 * line even at full output budget. Same proven pattern as teachingPreamble.
 */
export function deferredPreamble(prompt: string, now: Date = new Date()): string | null {
  if (!DEFERRED_RE.test(prompt)) return null;
  const clock = clockOffsetHint(prompt, now);
  return (
    'Part of this request happens LATER. Do the immediate part now with tools, ' +
    'then hand the later part to schedule_task (instruction = what to do, when = "+N" minutes from now) — ' +
    'schedule_task runs YOU again at that time to do it. Give `when` as a relative offset like "+3", ' +
    'never an absolute clock time: your own thinking takes minutes, so a timestamp you compute now is ' +
    'already stale by the time the tool runs. After handing it off, give your short final answer.' +
    (clock ? ` ${clock}` : '')
  );
}

/**
 * "Tonight at 9" needs a `when` of "+N" minutes, and a 2.6B model computing
 * minutes-until-nine from the clock line is where the rig saw it give up
 * (it checked the battery and never scheduled). The harness can do that
 * arithmetic: it reads the clock time off the sentence and says the offset.
 */
export function clockOffsetHint(prompt: string, now: Date): string | null {
  const m = /\b(?:at|by)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?\b/i.exec(prompt);
  if (!m) return null;
  let hour = parseInt(m[1]!, 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  const ampm = m[3]?.toLowerCase().replace(/\./g, '');
  if (hour > 23 || minute > 59) return null;
  if (ampm === 'pm' && hour < 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;
  const tomorrow = /\btomorrow\b/i.test(prompt);
  const evening = /\b(tonight|this evening|evening)\b/i.test(prompt);
  const candidate = (h: number) => {
    const t = new Date(now);
    if (tomorrow) t.setDate(t.getDate() + 1);
    t.setHours(h, minute, 0, 0);
    if (t.getTime() <= now.getTime()) t.setDate(t.getDate() + 1);
    return t;
  };
  let target: Date;
  if (ampm || hour >= 12) {
    target = candidate(hour);
  } else if (evening) {
    target = candidate(hour + 12);
  } else {
    // No am/pm: the sooner of the two readings is the one people mean
    // ("check again at 5" said at noon is 17:00, not tomorrow morning).
    const a = candidate(hour);
    const b = candidate(hour + 12);
    target = a.getTime() <= b.getTime() ? a : b;
  }
  const minutes = Math.round((target.getTime() - now.getTime()) / 60_000);
  const hh = String(target.getHours()).padStart(2, '0');
  const mm = String(target.getMinutes()).padStart(2, '0');
  return `The time mentioned (${hh}:${mm}) is ${minutes} minutes from now, so use when="+${minutes}".`;
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

// "put it in", "book me", "add it to my calendar" — placing something ON the
// calendar, which is calendar_create's job. schedule_task re-runs the AGENT
// later and cannot put anything in a calendar.
const CALENDAR_PLACE_RE =
  /\b(put it in|put .{0,20}\bon (my )?calendar|add .{0,20}\bto (my )?calendar|book (me )?(a |an )?|block (out )?|schedule (a |an )?(meeting|event|session|slot|gym))\b/i;

/**
 * Device evidence (calendar-judgment, 1458s, failed): asked to find a gym slot
 * tomorrow and "put it in", the model called
 * calendar_query, schedule_task, calendar_query, schedule_task, schedule_task
 * — never calendar_create. The tool description says "Putting an event or time
 * block ON THE CALENDAR is calendar_create, never schedule_task", but usage
 * hints are dropped on an overrun retry, so that guidance disappears exactly
 * when the model is flailing.
 *
 * When the request is calendar placement and has no deferred-agent half, the
 * tool that cannot be right is schedule_task.
 */
export function calendarToolExclusions(prompt: string): string[] {
  if (!CALENDAR_PLACE_RE.test(prompt) || DEFERRED_RE.test(prompt)) return [];
  return ['schedule_task'];
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
  if (isTeaching(prompt) || QUESTION_RE.test(prompt)) return null;
  const match = saidPhrase(prompt, macroNames);
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
  if (!isTeaching(prompt)) return null;
  const phrase = extractTaughtPhrase(prompt);
  return (
    'The user is TEACHING you a phrase, not asking you to act. You MUST call ' +
    'define_macro exactly once, with the phrase as `name` and every action as a ' +
    'step in `steps`. Do NOT perform any of the actions now.' +
    (phrase ? ` The phrase to record is "${phrase}".` : '')
  );
}

/**
 * The phrase being taught, when the sentence names it plainly. Rig evidence:
 * "If I ever ask for focus mode, dim the screen…" made the model ask "which
 * phrase?" because nothing was quoted; the harness can read it off the
 * sentence deterministically.
 */
export function extractTaughtPhrase(prompt: string): string | null {
  const quoted = /(?:say|ask for|tell you|called|named)\s+["“']([^"”']{2,40})["”']/i.exec(prompt);
  if (quoted) return quoted[1]!.trim().toLowerCase();
  const bare = /(?:when(?:ever)? i (?:say|ask for|tell you)|if i (?:ever )?(?:say|ask for|tell you)|(?:shortcut|macro|routine|command|phrase) (?:called|named|for))\s+([a-z][a-z0-9' -]{1,30}?)(?=\s*[,:;.]|\s+(?:that|which|then|to|and)\b|$)/i.exec(prompt);
  return bare ? bare[1]!.trim().toLowerCase() : null;
}

/**
 * Rig evidence (teach-devstate, 0/3): re-teaching a phrase that is already in
 * the taught-phrases list makes the model act AND define across 5-8 turns —
 * the list line says "call run_macro for this phrase" while the teaching line
 * says "only define_macro". While teaching: the list line must be dropped
 * from the preamble (callers check isTeaching) and run_macro hidden.
 */
export function isTeaching(prompt: string): boolean {
  // "What did I ask you to do when I say wind down?" contains the teaching
  // marker but is a QUESTION about a phrase. Device evidence: it was treated
  // as teaching, define_macro was the only tool allowed, and the model
  // overwrote the phrase with invented steps. A question is never a lesson.
  return TEACHING_RE.test(prompt) && !QUESTION_RE.test(prompt);
}

const QUESTION_RE = /\?\s*$|^\s*(what|which|how|where|who|why|did|do|does|can|could|would|is|are|tell me|remind me what|explain)\b/i;

/**
 * Every group except `vision`, which is attachment-gated (describe_image with
 * no image attached is a tool that can only be called wrongly).
 */
export const ALL_TOOL_GROUPS = ['memory', 'macro', 'device', 'schedule', 'web', 'comms', 'music'];

export interface ComposeOptions {
  /** Phrases the user has taught, by name. */
  macroNames?: string[];
  /** Full taught phrases, so a said phrase's steps can be shown to the model. */
  macros?: { name: string; steps: { tool: string; arguments: Record<string, unknown> }[] }[];
  /**
   * Remembered facts that match this message (the app runs the same fuzzy
   * recall the tool would). Injected into the context so a memory question is
   * answered from what is already known, with no tool call and no chance of a
   * misrouted "none" blocking it.
   */
  relevantFacts?: string[];
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
  /**
   * Router decision (router.ts): expose only the groups these categories
   * unlock. ['none'] means a plain conversation with no tools. Deterministic
   * guards (teaching, deferral, calendar placement) still add what they need.
   */
  categories?: RouterCategory[];
  /** The user switched tools off for this message. */
  noTools?: boolean;
  /**
   * Tool names per group, so a router decision can become an execution
   * allowlist. The app passes its registry's grouping; the rig passes the
   * mock registry's.
   */
  toolsByGroup?: Record<string, string[]>;
}

export interface RunComposition {
  /**
   * The request needs judgment (teaching, deferral, calendar placement, or a
   * multi-part instruction) and a thinking model should deliberate on every
   * turn. Simple single-action requests run with thinking closed (see
   * policy.thinkingStrategy) and get the answer in a couple of seconds.
   */
  deliberate: boolean;
  toolGroups: string[];
  /** Hidden for the session (user-disabled). */
  excludeTools: string[];
  /** Visible but refused at execution this run, with the reason the model gets. */
  denyTools: Record<string, string>;
  /** When set, only these may run this run (the rest are refused with allowExecuteReason). */
  allowExecuteOnly?: string[];
  allowExecuteReason?: string;
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
  // The taught-phrase list used to ride in EVERY prompt. It read as an
  // invitation: after teaching one phrase, "hello" ran it. Now the list only
  // appears when the message actually contains a taught phrase (whole words)
  // — and an exact match never reaches the model at all (reflex.ts).
  const said = saidPhrase(prompt, macroNames);
  if (said && !isTeaching(prompt)) {
    const macro = opts.macros?.find((m) => m.name.toLowerCase() === said.toLowerCase());
    const steps = macro ? macro.steps.map((s, i) => `${i + 1}. ${s.tool}(${Object.entries(s.arguments).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')})`).join(' ') : '';
    lines.push(
      `The user mentioned the taught phrase "${said}"${steps ? `, which performs: ${steps}` : ''}. If they are SAYING the phrase, call run_macro with that name; if they are asking ABOUT it, describe those steps. Do not redefine it.`,
    );
  }
  if (opts.relevantFacts && opts.relevantFacts.length > 0) {
    lines.push(`Facts you remembered earlier that may be relevant: ${opts.relevantFacts.map((f) => `"${f}"`).join('; ')}. Use them to answer directly if they cover the question.`);
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

  // Teaching needs a middle setting, and both extremes were measured.
  //
  // Everything exposed: the model performs the lesson instead of recording it
  // — teach-macro came back tools=[set_brightness, flashlight,
  // send_notification] with no macro. "Do NOT perform any of the actions now"
  // in the preamble loses to the tools being one call away.
  //
  // Only the macro group exposed: the model cannot act, and also cannot name
  // what it is recording, because the tool names ARE the vocabulary the steps
  // are written in. It produced steps=['set brightness to 20 percent', 'turn
  // flashlight off'] as prose, which define_macro's schema rejects
  // ("/steps/0: must be object").
  //
  // core + device + schedule is what a macro's steps can actually contain, and
  // it is the configuration teach-macro passed under repeatedly before the
  // exposure change. Web, comms and music can never appear in a macro step,
  // so they are pure temptation here.
  const teachingNow = isTeaching(prompt);
  const deliberate =
    teachingNow ||
    DEFERRED_RE.test(prompt) ||
    CALENDAR_PLACE_RE.test(prompt) ||
    /\b(then|and then|after that|before|unless|isn't|is not|that is not|but not|except)\b/i.test(prompt) ||
    prompt.split(/[,;]| and /i).length >= 3;

  // ONE system prompt per session. The engine caches the state of the
  // longest prefix it has seen, and on a hybrid model that cache is wiped the
  // moment a prompt with a different system section arrives. So the tool list
  // never changes shape per request: every group is visible (plus vision when
  // a photo is attached, minus the tools the user switched off, which are
  // constant for the session). What changes per request is what may RUN:
  //  - the router's categories become an execution allowlist;
  //  - the deterministic guards become per-tool refusals with a reason the
  //    model can act on ("use schedule_task instead");
  //  - "no tools" (router said none, or the user switched them off) is an
  //    empty allowlist plus a plain-conversation instruction.
  // Hiding still happens for `narrowExposure`, the legacy small-window mode.
  let toolGroups: string[];
  if (opts.narrowExposure) {
    toolGroups = [...routeToolGroups(prompt, macroNames), ...(opts.extraToolGroups ?? []), ...(opts.hasAttachment ? ['vision'] : [])];
  } else {
    toolGroups = [...ALL_TOOL_GROUPS, ...(opts.extraToolGroups ?? []), ...(opts.hasAttachment ? ['vision'] : [])];
  }

  const denyTools: Record<string, string> = {};
  for (const t of deferredToolExclusions(prompt)) {
    denyTools[t] = `${t} only rings a bell and cannot check or decide anything later. Hand the later part to schedule_task with when="+N".`;
  }
  for (const t of calendarToolExclusions(prompt)) {
    denyTools[t] = 'Putting something ON THE CALENDAR is calendar_create, never schedule_task.';
  }
  for (const t of teachingToolExclusions(prompt)) {
    denyTools[t] = 'The user is teaching a phrase. Record it with define_macro; do not run or remember anything now.';
  }
  for (const t of macroHit?.exclude ?? []) {
    denyTools[t] = `The user said a phrase they already taught. Call run_macro with that name instead of ${t}.`;
  }
  if (said && QUESTION_RE.test(prompt)) {
    // Device evidence: "what did I ask you to do when I say wind down?" RAN
    // the phrase. A question about a phrase describes it; it never runs it.
    denyTools['run_macro'] = `The user is asking ABOUT "${said}", not saying it. Describe its steps instead of running it.`;
  }
  if (!teachingNow && !denyTools['define_macro']) {
    // Device evidence: asked what a taught phrase does, the model REDEFINED
    // it with invented steps. Defining is only ever right while teaching.
    denyTools['define_macro'] = 'The user is not teaching a phrase right now. Answer from what you know; do not define or change any phrase.';
  }

  let allowExecuteOnly: string[] | undefined;
  let allowExecuteReason: string | undefined;
  if (opts.noTools) {
    allowExecuteOnly = [];
    allowExecuteReason = 'Tools are switched off for this message. Answer in plain conversation.';
    lines.push('Tools are switched off for this message: reply in plain conversation, do not call anything.');
  } else if (teachingNow) {
    allowExecuteOnly = ['define_macro'];
    allowExecuteReason = 'Record it as a step inside define_macro instead of running it now.';
  } else if (opts.categories) {
    if (opts.categories.length === 1 && opts.categories[0] === 'none') {
      allowExecuteOnly = [];
      allowExecuteReason = 'This message needs no tools. Answer in plain conversation.';
      lines.push(
        'This message needs no tools. Reply in plain conversation; do not call anything. If it turns out to need live or personal data you do not have (weather, news, prices, the user\'s own records), say you would need to look it up rather than guessing.',
      );
    } else {
      const groups = new Set(categoriesToGroups(opts.categories));
      if (DEFERRED_RE.test(prompt)) for (const g of ['schedule', 'device', 'memory']) groups.add(g);
      if (CALENDAR_PLACE_RE.test(prompt)) groups.add('schedule');
      if (said) groups.add('macro');
      if (opts.hasAttachment) groups.add('vision');
      for (const g of opts.extraToolGroups ?? []) groups.add(g);
      const allowed = (opts.toolsByGroup ? [...groups].flatMap((g) => opts.toolsByGroup![g] ?? []) : []);
      if (allowed.length > 0) {
        allowExecuteOnly = allowed;
        allowExecuteReason = `That tool is not relevant to this message. Relevant tools: ${allowed.join(', ')}. Use one of those, or answer directly.`;
      }
      lines.push(`This message is about: ${opts.categories.join(', ')}. Use only tools that serve that, or answer directly.`);
    }
  }

  return {
    deliberate,
    toolGroups,
    ...(allowExecuteOnly ? { allowExecuteOnly } : {}),
    ...(allowExecuteReason ? { allowExecuteReason } : {}),
    denyTools,
    // Hidden for the whole session: what the user switched off in Tools.
    excludeTools: [...(opts.extraExcludeTools ?? [])],
    preamble: lines.join('\n'),
  };
}

export function teachingToolExclusions(prompt: string): string[] {
  if (!isTeaching(prompt)) return [];
  // `remember` is the other trap: teaching a phrase looks enough like storing
  // a fact that the model writes the rule to memory and reports success
  // without ever defining the macro (device evidence: remember(fact='When
  // user says "wind down", set brightness to 20 percent...')). While the user
  // is TEACHING, neither replaying nor remembering can be the right call.
  return TEACHING_RE.test(prompt) ? ['run_macro', 'remember'] : [];
}
