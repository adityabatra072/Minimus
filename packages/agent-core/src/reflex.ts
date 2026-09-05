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
      return {
        call: { id: id(), name: 'flashlight', arguments: { on } },
        confirm: on ? 'Flashlight on.' : 'Flashlight off.',
      };
    },
  },
  {
    re: /^(?:(?:set|start|put on) (?:a |the )?)?(?:timer|countdown) (?:for |of )?(\d{1,3}) ?(?:min|mins|minute|minutes)$|^(?:(?:set|start) (?:a |the )?)?(\d{1,3})[ -]?(?:min|mins|minute|minutes) timer$/,
    make: (m) => {
      const minutes = Number(m[1] ?? m[2]);
      if (!Number.isFinite(minutes) || minutes <= 0) return null;
      return {
        call: { id: id(), name: 'set_timer', arguments: { minutes } },
        confirm: `Timer set for ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      };
    },
  },
  {
    // "wake me at 6:45", "set an alarm for 7", "alarm at 7:30 pm every day"
    re: /^(?:(?:set|put|start) (?:an? |the )?alarm (?:clock )?(?:for |at )?|wake me (?:up )?(?:at )?|alarm (?:for |at )?)(\d{1,2})(?::(\d{2}))? ?(am|pm|a\.m\.|p\.m\.)?(?: (every ?day|daily|each morning|every morning))?$/,
    make: (m) => {
      let hour = Number(m[1]);
      const minute = m[2] ? Number(m[2]) : 0;
      const mer = m[3]?.replace(/\./g, '').toLowerCase();
      if (!Number.isFinite(hour) || hour > 23 || minute > 59) return null;
      if (mer === 'pm' && hour < 12) hour += 12;
      if (mer === 'am' && hour === 12) hour = 0;
      const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
      const daily = Boolean(m[4]);
      const shown = new Date();
      shown.setHours(hour, minute, 0, 0);
      const label = shown.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      return {
        call: {
          id: id(),
          name: 'set_alarm',
          arguments: daily ? { time, repeat: 'daily' } : { time },
        },
        confirm: `Alarm set for ${label}${daily ? ', every day' : ''}.`,
      };
    },
  },
  {
    // "cancel the timer", "stop my timer", "pause the timer", "resume the timer"
    re: /^(?:please )?(cancel|stop|kill|pause|resume|unpause|continue) (?:the |my )?timer$/,
    make: (m) => {
      const verb = m[1]!.toLowerCase();
      const action = verb === 'pause' ? 'pause' : verb === 'resume' || verb === 'unpause' || verb === 'continue' ? 'resume' : 'cancel';
      return {
        call: { id: id(), name: 'timer_control', arguments: { action } },
        confirm: action === 'cancel' ? 'Timer cancelled.' : action === 'pause' ? 'Timer paused.' : 'Timer running again.',
      };
    },
  },
  {
    // "cancel my 6:45 alarm", "delete the 7 am alarm", "turn off the alarm at 6:45"
    re: /^(?:please )?(?:cancel|delete|remove|turn off|switch off|disable) (?:the |my )?(?:alarm (?:for |at )?)?(\d{1,2})(?::(\d{2}))? ?(am|pm|a\.m\.|p\.m\.)?(?: alarm)?$/,
    make: (m) => {
      let hour = Number(m[1]);
      const minute = m[2] ? Number(m[2]) : 0;
      const mer = m[3]?.replace(/\./g, '').toLowerCase();
      if (!Number.isFinite(hour) || hour > 23 || minute > 59) return null;
      if (mer === 'pm' && hour < 12) hour += 12;
      if (mer === 'am' && hour === 12) hour = 0;
      const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
      const shown = new Date();
      shown.setHours(hour, minute, 0, 0);
      return {
        call: { id: id(), name: 'cancel_alarm', arguments: { time } },
        confirm: `Alarm for ${shown.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} cancelled.`,
      };
    },
  },
  {
    // "cancel all alarms", "delete all my alarms"
    re: /^(?:please )?(?:cancel|delete|remove|turn off|clear) (?:all|every) (?:of )?(?:my |the )?alarms?$/,
    make: () => ({ call: { id: id(), name: 'cancel_alarm', arguments: { all: true } }, confirm: 'All alarms cancelled.' }),
  },
  {
    re: /^(?:set|put|turn|change) (?:the )?(?:screen )?brightness (?:to |at )?(\d{1,3}) ?(?:%|percent)$/,
    make: (m) => {
      const pct = Math.max(0, Math.min(100, Number(m[1])));
      return {
        call: { id: id(), name: 'set_brightness', arguments: { level: pct / 100 } },
        confirm: `Brightness set to ${pct}%.`,
      };
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
      confirm: (r) =>
        typeof r['storage_free_gb'] === 'number'
          ? `${r['storage_free_gb']} GB free.`
          : 'Here is your device status.',
    }),
  },
  {
    re: /^(?:open|launch) (spotify|settings|camera|maps|youtube|whatsapp|chrome|safari|mail|photos)$/,
    make: (m) => ({
      call: { id: id(), name: 'open_app', arguments: { app: m[1] } },
      confirm: `Opening ${m[1]}.`,
    }),
  },
];

/**
 * Match an utterance against the taught phrases and the fixed patterns.
 * Returns null whenever the request should go to the model.
 */
export function matchReflex(
  utterance: string,
  macroNames: string[],
  availableTools: Set<string>,
): Reflex | null {
  const text = norm(utterance);
  if (!text) return null;
  // Taught phrase said on its own (with optional "run"/"do" in front).
  const phrase = text.replace(/^(?:run|do|execute|go) /, '');
  const macro = macroNames.find((m) => m.trim().toLowerCase() === phrase);
  if (macro && availableTools.has('run_macro')) {
    return {
      call: { id: id(), name: 'run_macro', arguments: { name: macro } },
      confirm: `Done — "${macro}".`,
    };
  }
  for (const { re, make } of PATTERNS) {
    const m = text.match(re);
    if (!m) continue;
    const reflex = make(m);
    if (reflex && availableTools.has(reflex.call.name)) return reflex;
  }
  return null;
}
