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
 * Routing is keyword-based and additive: 'core' tools (memory, macros) ride
 * along always; unmatched prompts get the broad default set.
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
];

const DEFAULT_GROUPS = ['device', 'schedule', 'music'];

export function routeToolGroups(prompt: string): string[] {
  const groups = new Set<string>(['core']);
  for (const [re, group] of GROUP_TRIGGERS) {
    if (re.test(prompt)) groups.add(group);
  }
  if (groups.size === 1) for (const g of DEFAULT_GROUPS) groups.add(g);
  return [...groups];
}

const TEACHING_RE = /\b(new rule|when(ever)? i say|teach you|from now on,? when)\b/i;

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
