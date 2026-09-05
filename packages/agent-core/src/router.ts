import type { GenerateOptions, ModelAdapter } from './adapter.js';
import type { ChatMessage } from './types.js';

/**
 * The router: a tiny classification pass that decides WHICH tools the main
 * pass gets to see, before it sees any.
 *
 * Why it exists: with every tool visible, a small model is tool-happy.
 * "hello" after teaching a phrase ran the phrase; small talk reached for
 * device_info. Keyword routing was tried and failed on ordinary sentences.
 * This uses the model itself as the classifier, but boxed in:
 *
 *  - a short fixed prompt with examples, so it is cached after the first call;
 *  - thinking closed, a handful of output tokens;
 *  - a GBNF grammar that only admits category names, so the output cannot be
 *    prose, a tool call, or anything the parser has to guess about.
 *
 * "none" is a first-class answer: the request is conversation or general
 * knowledge, and the main pass runs with no tools at all.
 */

export const ROUTER_CATEGORIES = [
  'none',
  'phone',
  'calendar',
  'memory',
  'later',
  'teach',
  'web',
  'messages',
  'music',
] as const;

export type RouterCategory = (typeof ROUTER_CATEGORIES)[number];

/** Tool groups each category unlocks (see tools' `group`). */
export const CATEGORY_GROUPS: Record<RouterCategory, string[]> = {
  none: [],
  phone: ['device'],
  calendar: ['schedule'],
  memory: ['memory'],
  later: ['schedule', 'device', 'memory'],
  teach: ['macro', 'device', 'schedule'],
  web: ['web'],
  messages: ['comms'],
  music: ['music'],
};

/**
 * The routing rules live INSIDE the shared system prompt (prompts.ts appends
 * this section), so the router pass and the main pass have byte-identical
 * prefixes and the engine serves both from one cached state. A separate
 * router prompt was tried first: every switch between it and the main prompt
 * wiped the hybrid model's state cache, and every message paid full prefill
 * twice.
 */
export const ROUTER_SECTION = [
  '## Routing',
  'Before acting you may be asked which ability categories a message needs. Categories:',
  '- none: conversation, greetings, thanks, opinions, general knowledge, writing, math, questions about you.',
  '- phone: flashlight, brightness, battery, storage, opening an app or website, clipboard.',
  '- calendar: events, meetings, free time, alarms, timers, reminders, notifications.',
  '- memory: remembering a fact for later, recalling something the user told you before, or forgetting/deleting a saved fact or taught phrase.',
  '- later: doing or checking something at a later time on its own ("in 20 minutes", "tonight at 9, check").',
  '- teach: the user is defining a phrase or rule for you to perform later ("when I say X, do Y").',
  '- web: looking something up online, news, current facts you cannot know.',
  '- messages: texting, emailing, calling someone, looking up a contact.',
  '- music: playing songs, artists, playlists.',
  'When a message might need an ability, include that category; several are fine. Use none ONLY for pure conversation or knowledge where no phone ability could help.',
  'Examples: "hello" → none · "Morning! How are you doing?" → none · "what is the weather like in London right now" → web · "what is my locker code" → memory · "what was the wifi password I told you" → memory · "what did I ask you to do when I say wind down" → memory · "thanks, that was great" → none · "what is the capital of France" → none · "tell me a joke" → none · "what can you do" → none · "turn on the flashlight" → phone · "how much battery do I have" → phone · "what have I got on Friday" → calendar · "set a timer for 12 minutes" → calendar · "cancel my alarm" → calendar · "move my alarm to 7" → calendar · "add five minutes to the timer" → calendar · "remember that my locker code is 4471" → memory · "forget my locker code" → memory · "delete what I told you about Sarah" → memory · "what did I tell you about Thursday" → memory · "in 20 minutes check my battery and tell me if it dropped" → later · "new rule: when I say wind down, dim the screen" → teach · "who won the Monaco Grand Prix" → web · "let Sam know I am running late" → messages · "put on something by Radiohead" → music',
].join('\n');

/**
 * The router's own system prompt. It runs in a DEDICATED engine lane (a second
 * context on the same weights), so it keeps its own cached prefix and never
 * competes with the main prompt for the state cache. Measured on the rig:
 * this standalone prompt classifies better than the same rules embedded in
 * the 1800-token main prompt (which pulled the model toward "none").
 */
export const ROUTER_SYSTEM_PROMPT = [
  'You sort a message from a phone user into the abilities it needs. Reply with one or more category names, comma-separated, and nothing else.',
  'When a message might need an ability, include that category — several are fine. Use none ONLY for pure conversation or knowledge where no phone ability could help.',
  ...ROUTER_SECTION.split('\n').slice(2),
].join('\n');

/**
 * GBNF: either exactly "none", or one to three real categories. "none" cannot
 * be padded with extras — under the shared system prompt the model started
 * answering "none, phone, calendar" to a greeting, which the parser then read
 * as phone+calendar.
 */
export function routerGrammar(): string {
  const alts = ROUTER_CATEGORIES.filter((c) => c !== 'none')
    .map((c) => `"${c}"`)
    .join(' | ');
  return `root ::= "none" | cat ("," " "? cat){0,2}\ncat ::= ${alts}\n`;
}

export function routerMessages(message: string): ChatMessage[] {
  return [
    { role: 'system', content: ROUTER_SYSTEM_PROMPT },
    { role: 'user', content: message.trim().slice(0, 400) },
  ];
}

export function parseRouterOutput(text: string): RouterCategory[] {
  const found = new Set<RouterCategory>();
  for (const part of text.toLowerCase().split(/[,\s]+/)) {
    const clean = part.replace(/[^a-z]/g, '') as RouterCategory;
    if ((ROUTER_CATEGORIES as readonly string[]).includes(clean)) found.add(clean);
  }
  // "none" first is decisive (the grammar only allows it alone); anywhere
  // else it is padding.
  if (/^\s*none\b/i.test(text)) return ['none'];
  if (found.size > 1) found.delete('none');
  return found.size === 0 ? ['none'] : [...found];
}

export interface RouteDecision {
  categories: RouterCategory[];
  /** Tool groups the main pass should expose (empty = no tools). */
  toolGroups: string[];
  ms: number;
  /** Raw model output, for diagnostics. */
  raw: string;
}

export function categoriesToGroups(categories: RouterCategory[]): string[] {
  const groups = new Set<string>();
  for (const c of categories) for (const g of CATEGORY_GROUPS[c]) groups.add(g);
  return [...groups];
}

/**
 * A message that asks for something to be DONE. When the router says "none"
 * for one of these, the router is the one that is wrong: the main pass gets
 * every tool, exactly as before the router existed. The cost of that fallback
 * is a longer prompt; the cost of trusting a wrong "none" would be an agent
 * that answers "I would turn it on" instead of turning it on.
 */
export const ACTION_RE =
  /\b(turn|switch|set|open|launch|start|stop|play|pause|call|text|message|email|send|remind|remember|recall|forget|note|save|schedule|book|add|create|make|put|check|look|find|search|google|tell me (?:when|if|about)|wake|alarm|timer|flashlight|torch|brightness|battery|storage|calendar|meeting|dim|copy|paste|clipboard|navigate|directions|what(?:'s| is) (?:my|the) (?:battery|schedule|storage)|how much (?:battery|storage|space))\b/i;

/** The categories to hand to composeRun, after the recall safety net. */
/** Questions whose honest answer needs a lookup: a "none" here is a router miss. */
export const LIVE_FACT_RE =
  /\b(weather|forecast|temperature|news|headline|price|stock|score|result|match|game|won|winner|latest|right now|currently|today's|tonight's|this week|open now|nearby|near me|directions|how far|exchange rate|convert)\b/i;

export function effectiveCategories(decision: RouterCategory[], message: string): RouterCategory[] | undefined {
  if (decision.length === 1 && decision[0] === 'none' && ACTION_RE.test(message)) return undefined;
  if (decision.length === 1 && decision[0] === 'none' && LIVE_FACT_RE.test(message)) return ['web'];
  return decision;
}

/**
 * Run the classification pass through any adapter (the phone's engine or the
 * laptop rig's llama-server). Adapters that ignore `grammar` still work; the
 * parser tolerates prose around the category words.
 */
export async function routeWithModel(adapter: ModelAdapter, message: string, signal?: AbortSignal): Promise<RouteDecision> {
  const started = Date.now();
  const options: GenerateOptions = {
    temperature: 0,
    topP: 1,
    maxOutputTokens: 12,
    thinkingMode: 'closed',
    grammar: routerGrammar(),
    ...(signal ? { signal } : {}),
  };
  let raw = '';
  for await (const ev of adapter.generate(routerMessages(message), options)) {
    if (ev.type === 'delta') raw += ev.text;
  }
  const categories = parseRouterOutput(raw.replace(/<think>[\s\S]*?<\/think>/g, ''));
  return { categories, toolGroups: categoriesToGroups(categories), ms: Date.now() - started, raw: raw.trim() };
}
