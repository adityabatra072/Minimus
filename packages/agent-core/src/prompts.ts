import type { ToolDefinition } from './tools.js';
import type { WireFormat } from './parsing.js';

/**
 * System prompt builder. Kept deliberately short: small models follow short,
 * imperative prompts far better than long constitutions. The tool list is the
 * bulk of the prompt; instructions are ~10 lines.
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

export interface PromptOptions {
  format: WireFormat;
  oneToolPerTurn: boolean;
  /**
   * Drop the per-tool usage hints. They earn their tokens on a first attempt
   * (they are what keeps a small model from misrouting), but on a retry after
   * a thinking overrun the budget is worth more than the guidance.
   */
  omitHints?: boolean;
  /** Extra persona/context lines from the app (device, user name, date). */
  preamble?: string;
  /** Injected as "Current date/time" — defaults to now. Pass a fixed value in tests. */
  now?: Date;
}

export function buildSystemPrompt(tools: ToolDefinition[], opts: PromptOptions): string {
  const lines: string[] = [];
  lines.push(
    opts.preamble ??
      'You are Minimus, a capable assistant running fully on this phone. You get things DONE using tools, then confirm briefly.',
  );
  // Models cannot know the wall clock, and scheduling tasks send small models
  // into "but I don't know the current time" spirals without this line.
  const now = opts.now ?? new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const local = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())} (${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][now.getDay()]})`;
  lines.push(`Current date/time: ${local}.`);
  lines.push('');
  lines.push('## Tools');
  for (const t of tools) {
    if (opts.omitHints) {
      const { usageHint: _dropped, ...withoutHint } = t;
      lines.push(toolLine(withoutHint));
    } else {
      lines.push(toolLine(t));
    }
  }
  lines.push('');
  lines.push('## Rules');
  if (opts.format === 'hermes') {
    lines.push(
      'To use a tool, reply with exactly:',
      '<tool_call>{"name": "tool_name", "arguments": {"param": "value"}}</tool_call>',
    );
  } else {
    lines.push('To use a tool, reply with exactly: [tool_name(param="value")]');
  }
  if (opts.oneToolPerTurn) {
    lines.push('Call at most ONE tool per reply. Wait for its result before the next step.');
  }
  lines.push(
    'After a tool result arrives, either call the next tool needed or give the user a short final answer.',
    'Use tools only when needed — if you already know the answer, answer directly without tools.',
    'Never repeat a tool call you already made; its result is already above. Once you have what you need, STOP calling tools and answer.',
    'Never invent tool results. Never call tools that are not listed.',
    // Visible thinking is billed against a phone-sized token budget and the
    // user's patience — long deliberation is the #1 latency cost on device.
    'Think briefly: a couple of sentences of thinking at most, then act.',
  );
  // Usage hints render inline under each tool line only. They used to repeat
  // in a trailing section, which cost ~200 prompt tokens — real money on
  // devices where the llamacpp backend caps the window at 2048 and generation
  // gets whatever the prompt leaves behind.
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
