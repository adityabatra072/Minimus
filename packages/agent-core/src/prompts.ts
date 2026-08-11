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
  return `- ${tool.name}(${params}): ${tool.description}`;
}

export interface PromptOptions {
  format: WireFormat;
  oneToolPerTurn: boolean;
  /** Extra persona/context lines from the app (device, user name, date). */
  preamble?: string;
}

export function buildSystemPrompt(tools: ToolDefinition[], opts: PromptOptions): string {
  const lines: string[] = [];
  lines.push(
    opts.preamble ??
      'You are Minimus, a capable assistant running fully on this phone. You get things DONE using tools, then confirm briefly.',
  );
  lines.push('');
  lines.push('## Tools');
  for (const t of tools) lines.push(toolLine(t));
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
    'If no tool is needed, just answer directly.',
    'Never invent tool results. Never call tools that are not listed.',
  );
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
