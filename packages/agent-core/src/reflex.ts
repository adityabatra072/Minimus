/**
 * Reflexes: requests so unambiguous that consulting a language model is a
 * waste of the user's time. A reflex maps one sentence to exactly one tool
 * call and a fixed confirmation, deterministically, in under a millisecond.
 *
 * The bar for a reflex is high on purpose. Every pattern here is anchored to
 * the whole utterance and names a single tool with all of its arguments
 * literal in the sentence. Anything with a clause, a condition, a time, a
 * person or a judgment is NOT a reflex and goes to the model. A false positive
 * would do the wrong thing instantly; a false negative costs two seconds.
 *
 * The taught-phrase reflex is the important one: a phrase the user taught is
 * a name for a macro, and saying it should be as instant as pressing a button.
 */

import type { ToolCall } from './types.js';

export interface Reflex {
  call: ToolCall;
  /** What the app says once the tool succeeds (the model is never asked). */
  confirm: string | ((result: Record<string, unknown>) => string);
}

function norm(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/^(hey |ok |okay |please |minimus,? |can you |could you |would you )+/g, '')
    .replace(/[.!?]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

let n = 0;
const id = () => `reflex_${Date.now().toString(36)}_${++n}`;

const PATTERNS: { re: RegExp; make: (m: RegExpMatchArray) => Reflex | null }[] = [
  {
    re: /^(?:turn|switch|put) (?:the )?(?:flashlight|torch|flash light) (on|off)$|^(?:turn|switch) (on|off) (?:the |my )?(?:flashlight|torch|flash light)$|^(?:flashlight|torch) (on|off)$/,
    make: (m) => {
      const on = (m[1] ?? m[2] ?? m[3]) === 'on';
      return { call: { id: id(), name: 'flashlight', arguments: { on } }, confirm: on ? 'Flashlight on.' : 'Flashlight off.' };
    },
  },
  {
    re: /^(?:set|start) (?:a |the )?(?:timer|countdown) (?:for |of )?(\d{1,3}) ?(?:min|mins|minute|minutes)$|^(\d{1,3}) ?(?:min|mins|minute|minutes) timer$/,
    make: (m) => {
      const minutes = Number(m[1] ?? m[2]);
      if (!Number.isFinite(minutes) || minutes <= 0) return null;
      return { call: { id: id(), name: 'set_timer', arguments: { minutes } }, confirm: `Timer set for ${minutes} minute${minutes === 1 ? '' : 's'}.` };
    },
  },
  {
    re: /^(?:set|put|turn|change) (?:the )?(?:screen )?brightness (?:to |at )?(\d{1,3}) ?(?:%|percent)$/,
    make: (m) => {
      const pct = Math.max(0, Math.min(100, Number(m[1])));
      return { call: { id: id(), name: 'set_brightness', arguments: { level: pct / 100 } }, confirm: `Brightness set to ${pct}%.` };
    },
  },
  {
    re: /^(?:what(?:'s| is) (?:my |the )?battery(?: level| percentage| at)?|how much battery (?:do i have|is left|have i got)(?: left)?|battery(?: level)?)$/,
    make: () => ({
      call: { id: id(), name: 'device_info', arguments: {} },
      confirm: (r) =>
        typeof r['battery_percent'] === 'number'
          ? `Battery is at ${r['battery_percent']}%${r['charging'] ? ', charging' : ''}.`
          : 'Here is your device status.',
    }),
  },
  {
    re: /^(?:how much (?:storage|space)(?: do i have| is left| have i got)(?: left)?(?: on (?:this|my) phone)?|(?:free|available) (?:storage|space))$/,
    make: () => ({
      call: { id: id(), name: 'device_info', arguments: {} },
      confirm: (r) => (typeof r['storage_free_gb'] === 'number' ? `${r['storage_free_gb']} GB free.` : 'Here is your device status.'),
    }),
  },
  {
    re: /^(?:open|launch) (spotify|settings|camera|maps|youtube|whatsapp|chrome|safari|mail|photos)$/,
    make: (m) => ({ call: { id: id(), name: 'open_app', arguments: { app: m[1] } }, confirm: `Opening ${m[1]}.` }),
  },
];

/**
 * Match an utterance against the taught phrases and the fixed patterns.
 * Returns null whenever the request should go to the model.
 */
export function matchReflex(utterance: string, macroNames: string[], availableTools: Set<string>): Reflex | null {
  const text = norm(utterance);
  if (!text) return null;
  // Taught phrase said on its own (with optional "run"/"do" in front).
  const phrase = text.replace(/^(?:run|do|execute|go) /, '');
  const macro = macroNames.find((m) => m.trim().toLowerCase() === phrase);
  if (macro && availableTools.has('run_macro')) {
    return { call: { id: id(), name: 'run_macro', arguments: { name: macro } }, confirm: `Done — "${macro}".` };
  }
  for (const { re, make } of PATTERNS) {
    const m = text.match(re);
    if (!m) continue;
    const reflex = make(m);
    if (reflex && availableTools.has(reflex.call.name)) return reflex;
  }
  return null;
}
