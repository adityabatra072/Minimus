import type { ToolDefinition } from './tools.js';
import type { WireFormat } from './parsing.js';
import { ROUTER_SECTION } from './router.js';

/**
 * System prompt builder. Kept deliberately short: small models follow short,
 * imperative prompts far better than long constitutions. The tool list is the
 * bulk of the prompt; instructions are ~10 lines.
 *
 * LAYOUT MATTERS FOR SPEED. The engine caches the KV/state of the longest
 * prefix it has already seen, so everything that is the same from one run to
 * the next (persona, tools, rules) comes FIRST, and everything that changes
 * (the clock, the taught-phrase list, per-request steering) comes LAST. With
 * the date at the top, a prompt went stale every minute and the whole ~1200
 * token tool section was re-prefilled on every single run.
 */

function toolLine(tool: ToolDefinition): string {
  const params = tool.parameters.properties
    ? Object.entries(tool.parameters.properties)
        .map(([name, schema]) => {
          const required = tool.parameters.required?.includes(name) ? '' : '?';
          const type = schema.type ?? 'any';
          const desc = schema.description ? ` — ${schema.description}` : '';
          const enums = schema.enum ? ` (one of: ${schema.enum.join(', ')})` : '';
          return `${name}${required}: ${type}${enums}${desc}`;
        })
        .join('; ')
    : '';
  const line = `- ${tool.name}(${params}): ${tool.description}`;
  // A hint bound to its own tool line is read; the same text in a trailing
  // section gets skimmed past by small models.
  return tool.usageHint ? `${line}
    ↳ ${tool.usageHint}` : line;
}

export type ToolListFormat = 'compact' | 'lfm-json';

export interface PromptOptions {
  format: WireFormat;
  /**
   * How the tool list is written. `compact` is one dense line per tool;
   * `lfm-json` is the JSON array LFM2.5 was trained on ("List of tools:
   * [{...}]"), which costs more tokens but is on-distribution for the model.
   */
  toolFormat?: ToolListFormat;
  /**
   * The model deliberates before answering. Non-thinking models get rules
   * that demand the call FIRST: rig evidence on LFM2.5-1.2B is that "think
   * briefly, then act" makes it write its intent as prose and stop ("I'll
   * check your battery now."), never emitting the call.
   */
  thinking?: boolean;
  oneToolPerTurn: boolean;
  /**
   * Drop the per-tool usage hints. They earn their tokens on a first attempt
   * (they are what keeps a small model from misrouting), but on a retry after
   * a thinking overrun the budget is worth more than the guidance.
   */
  omitHints?: boolean;
  /**
   * Persona/context lines from the app. The FIRST line is treated as the
   * stable persona and leads the prompt; every following line is per-request
   * context and is placed after the rules so the cached prefix survives.
   */
  preamble?: string;
  /** Append the routing categories (the router pass shares this prompt). */
  routing?: boolean;
}

export const DEFAULT_PERSONA =
  'You are Minimus, a capable assistant running fully on this phone. You get things DONE using tools, then confirm briefly.';

export function formatClock(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())} (${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][now.getDay()]})`;
}

/** First line of a preamble is the stable persona; the rest is per-request context. */
export function splitPreamble(preamble: string | undefined): { persona: string; context: string[] } {
  const lines = (preamble ?? DEFAULT_PERSONA).split('\n').filter((l) => l.trim() !== '');
  return { persona: lines[0] ?? DEFAULT_PERSONA, context: lines.slice(1) };
}

/**
 * The volatile part of what the model is told — the clock and the
 * per-request steering — rendered as a block that PRECEDES the user's message
 * inside the user turn, not inside the system prompt. Two reasons: the
 * system prompt stays byte-identical across requests, so the engine's cached
 * state for it (a message-boundary checkpoint on hybrid models) is reusable;
 * and small models attend hardest to the text nearest the request, which is
 * where steering belongs anyway.
 */
export function buildContextBlock(context: string[], now: Date = new Date()): string {
  const lines = ['Context for the next message:', `Current date/time: ${formatClock(now)}.`, ...context];
  return lines.join('\n');
}

export function buildSystemPrompt(tools: ToolDefinition[], opts: PromptOptions): string {
  const { persona } = splitPreamble(opts.preamble);

  const lines: string[] = [];
  lines.push(persona);
  if (tools.length === 0) {
    // Conversation mode: no tool list, no call syntax, nothing to misgrab.
    lines.push(
      'No tools are available for this message. Answer directly, helpfully and briefly, in plain sentences. If the user asks you to do something on the phone, say that they can ask again with tools switched on.',
    );
    return lines.join('\n');
  }
  lines.push('');
  if (opts.toolFormat === 'lfm-json') {
    lines.push(
      'List of tools: [' +
        tools
          .map((t) =>
            JSON.stringify({
              name: t.name,
              description: opts.omitHints || !t.usageHint ? t.description : `${t.description}. ${t.usageHint}`,
              parameters: t.parameters,
            }),
          )
          .join(', ') +
        ']',
    );
  } else {
    lines.push('## Tools');
    for (const t of tools) {
      if (opts.omitHints) {
        const { usageHint: _dropped, ...withoutHint } = t;
        lines.push(toolLine(withoutHint));
      } else {
        lines.push(toolLine(t));
      }
    }
  }
  lines.push('');
  lines.push('## Rules');
  const example =
    opts.format === 'hermes'
      ? '<tool_call>{"name": "flashlight", "arguments": {"on": false}}</tool_call>'
      : '<|tool_call_start|>[flashlight(on=False)]<|tool_call_end|>';
  if (opts.thinking === false) {
    // Small non-thinking models: the rig showed they otherwise narrate the
    // action instead of performing it, or claim they have no such tool.
    lines.push(
      'You have real tools (listed above) and you MUST use them to act on the phone. Never say you cannot do something a listed tool does.',
      `Example — user: "turn the torch off" → you: ${example}`,
      'Reply with the tool call FIRST, nothing before it.',
    );
  } else {
    // A concrete example, not a placeholder: shown `[tool_name(param="value")]`
    // the model once replied `[tool_name(flashlight(on="true"))]` verbatim.
    lines.push(`To use a tool, reply with a call formatted like this example: ${example}`);
  }
  if (opts.oneToolPerTurn) {
    lines.push('Call at most ONE tool per reply. Wait for its result before the next step.');
  }
  lines.push(
    'After a tool result arrives, either call the next tool needed or give the user a short final answer.',
    'Use tools only when needed — if you already know the answer, answer directly without tools.',
    'Never repeat a tool call you already made; its result is already above. Once you have what you need, STOP calling tools and answer.',
    'Never invent tool results. Never call tools that are not listed.',
  );
  if (opts.thinking !== false) {
    // Visible thinking is billed against a phone-sized token budget and the
    // user's patience — long deliberation is the #1 latency cost on device.
    lines.push('Think briefly: a couple of sentences of thinking at most, then act.');
  }
  if (opts.routing) {
    lines.push('');
    lines.push(ROUTER_SECTION);
  }
  return lines.join('\n');
}

/** One-line nudge appended after a failed parse/validation, then we retry. */
export function retryNudge(reason: string, format: WireFormat): string {
  const example =
    format === 'hermes'
      ? '<tool_call>{"name": "tool_name", "arguments": {}}</tool_call>'
      : '[tool_name(param="value")]';
  return `${reason} Reply again with a valid tool call formatted exactly like ${example}, or answer the user directly without a tool.`;
}
