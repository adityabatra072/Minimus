import type { ToolCall } from './types.js';

/**
 * Tool-call parsers for the wire formats emitted by on-device models.
 *
 * The harness owns parsing (rather than trusting engine-level parsers) because
 * engine behavior differs per platform and per GGUF: e.g. LFM2.5 GGUFs mark
 * `<|tool_call_start|>` as a special token, which llama.cpp detokenizes to
 * NOTHING — so the tags may or may not be present in the visible text. Parsers
 * here accept both tagged and bare forms.
 *
 * Formats:
 *  - hermes/qwen: `<tool_call>{"name": "...", "arguments": {...}}</tool_call>`
 *    (also accepts `{"tool": ..., "arguments": ...}` and bare trailing JSON)
 *  - lfm/pythonic: `<|tool_call_start|>[func(a="x", b=2)]<|tool_call_end|>`
 *    or the bare `[func(a="x")]` form when tags were swallowed as specials.
 */

export interface ParsedOutput {
  /** Visible assistant text with tool-call blocks and think blocks removed. */
  text: string;
  /** Extracted `<think>...</think>` content, if any. */
  reasoning: string;
  calls: ParsedCall[];
}

export interface ParsedCall {
  name: string;
  arguments: Record<string, unknown>;
  /** Raw source span, for error messages. */
  raw: string;
}

let callCounter = 0;
export function toToolCall(parsed: ParsedCall): ToolCall {
  callCounter += 1;
  return { id: `call_${Date.now().toString(36)}_${callCounter}`, name: parsed.name, arguments: parsed.arguments };
}

/** Strip <think> blocks (Qwen thinking mode); tolerate an unopened `</think>`. */
export function extractReasoning(output: string): { text: string; reasoning: string } {
  let reasoning = '';
  let text = output;
  const closed = /<think>([\s\S]*?)<\/think>/g;
  text = text.replace(closed, (_m, inner: string) => {
    reasoning += inner.trim() + '\n';
    return '';
  });
  // A dangling `</think>` means the template opened the block inside the prompt:
  // everything before the close tag is reasoning.
  const dangling = text.indexOf('</think>');
  if (dangling !== -1) {
    reasoning += text.slice(0, dangling).trim() + '\n';
    text = text.slice(dangling + '</think>'.length);
  }
  return { text, reasoning: reasoning.trim() };
}

const HERMES_BLOCK = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
const LFM_TAGGED = /<\|tool_call_start\|>\s*([\s\S]*?)\s*<\|tool_call_end\|>/g;

function tryParseJsonCall(jsonText: string): ParsedCall | null {
  try {
    const obj = JSON.parse(jsonText) as Record<string, unknown>;
    const name = (obj['name'] ?? obj['tool'] ?? obj['function']) as string | undefined;
    if (!name || typeof name !== 'string') return null;
    let args = obj['arguments'] ?? obj['parameters'] ?? obj['args'] ?? {};
    if (typeof args === 'string') {
      // Models sometimes double-encode arguments.
      try {
        args = JSON.parse(args);
      } catch {
        return null;
      }
    }
    if (typeof args !== 'object' || args === null || Array.isArray(args)) return null;
    return { name, arguments: args as Record<string, unknown>, raw: jsonText };
  } catch {
    return null;
  }
}

/**
 * Parse one pythonic call `func(a="x", b=2)` (LFM wire format).
 * Values: single/double-quoted strings, numbers, true/false/null, and
 * conservative bare words (treated as strings).
 */
function tryParsePythonicCall(src: string): ParsedCall | null {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\(([\s\S]*)\)\s*$/.exec(src);
  if (!m) return null;
  const name = m[1]!;
  const argsSrc = m[2]!;
  const args: Record<string, unknown> = {};
  let i = 0;
  const n = argsSrc.length;
  const skipWs = () => {
    while (i < n && /\s/.test(argsSrc[i]!)) i++;
  };
  while (i < n) {
    skipWs();
    if (i >= n) break;
    const keyMatch = /^([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(argsSrc.slice(i));
    if (!keyMatch) return null;
    const key = keyMatch[1]!;
    i += keyMatch[0].length;
    skipWs();
    const ch = argsSrc[i];
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      let value = '';
      while (i < n) {
        const c = argsSrc[i]!;
        if (c === '\\' && i + 1 < n) {
          value += argsSrc[i + 1];
          i += 2;
          continue;
        }
        if (c === quote) break;
        value += c;
        i++;
      }
      if (i >= n) return null; // unterminated string
      i++; // closing quote
      args[key] = value;
    } else if (ch === '[' || ch === '{') {
      // Bracketed literal: scan to the matching close, then JSON-parse
      // (single quotes normalized). Good enough for flat lists of scalars.
      const open = ch;
      const close = open === '[' ? ']' : '}';
      let depth = 0;
      const start = i;
      while (i < n) {
        const c = argsSrc[i]!;
        if (c === open) depth++;
        else if (c === close) {
          depth--;
          if (depth === 0) {
            i++;
            break;
          }
        }
        i++;
      }
      const literal = argsSrc.slice(start, i).replace(/'/g, '"');
      try {
        args[key] = JSON.parse(literal);
      } catch {
        return null;
      }
    } else {
      const bare = /^[^,)]+/.exec(argsSrc.slice(i));
      if (!bare) return null;
      const word = bare[0].trim();
      i += bare[0].length;
      if (word === 'true' || word === 'True') args[key] = true;
      else if (word === 'false' || word === 'False') args[key] = false;
      else if (word === 'null' || word === 'None') args[key] = null;
      else if (/^-?\d+(\.\d+)?$/.test(word)) args[key] = Number(word);
      else args[key] = word;
    }
    skipWs();
    if (argsSrc[i] === ',') i++;
  }
  return { name, arguments: args, raw: src };
}

/** Parse `[func(...), func2(...)]` or `func(...)` — the LFM list form. */
function parsePythonicList(src: string): ParsedCall[] {
  const inner = src.trim().replace(/^\[/, '').replace(/\]$/, '');
  const calls: ParsedCall[] = [];
  // Split on top-level `),` boundaries.
  let depth = 0;
  let inString: string | null = null;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!;
    if (inString) {
      if (c === '\\') i++;
      else if (c === inString) inString = null;
      continue;
    }
    if (c === '"' || c === "'") inString = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      const piece = inner.slice(start, i);
      const parsed = tryParsePythonicCall(piece);
      if (parsed) calls.push(parsed);
      start = i + 1;
    }
  }
  const last = inner.slice(start);
  if (last.trim()) {
    const parsed = tryParsePythonicCall(last);
    if (parsed) calls.push(parsed);
  }
  return calls;
}

export type WireFormat = 'hermes' | 'pythonic';

/**
 * Parse a complete assistant output into text + reasoning + tool calls.
 *
 * `knownTools` guards the bare-form fallbacks: a bare `[something(...)]` or a
 * trailing JSON object is only treated as a tool call when it names a
 * registered tool. Tagged forms are always honored (they can then fail
 * validation with a model-visible error, which retries better than silence).
 */
export function parseAssistantOutput(
  output: string,
  format: WireFormat,
  knownTools: string[],
): ParsedOutput {
  const { text: withoutThink, reasoning } = extractReasoning(output);
  let text = withoutThink;
  const calls: ParsedCall[] = [];
  const known = new Set(knownTools);

  // 1. Tagged forms (either format's tags may appear regardless of the family —
  //    fine-tunes are messy; accept both).
  text = text.replace(HERMES_BLOCK, (_m, inner: string) => {
    const parsed = tryParseJsonCall(inner);
    if (parsed) calls.push(parsed);
    return '';
  });
  text = text.replace(LFM_TAGGED, (_m, inner: string) => {
    for (const c of parsePythonicList(inner)) calls.push(c);
    return '';
  });

  if (calls.length === 0) {
    const trimmed = text.trim();
    // Whole-output call attempt: the reply IS a call (nothing else). Parse it
    // even when the tool name is unknown, so validation can nudge a retry —
    // otherwise a typo'd tool name would silently become the "final answer".
    const wholePythonic = /^\[\s*[A-Za-z_][A-Za-z0-9_.-]*\s*\([\s\S]*\)\s*\]$/.test(trimmed);
    if (format === 'pythonic' && wholePythonic) {
      const parsed = parsePythonicList(trimmed);
      if (parsed.length > 0) {
        calls.push(...parsed);
        text = '';
      }
    } else if (format === 'pythonic') {
      // Bare `[func(...)]` embedded in prose — only trust it for KNOWN tools
      // (citations like "[see note(1)]" must stay text).
      const bare = /\[\s*[A-Za-z_][A-Za-z0-9_.-]*\s*\([\s\S]*?\)\s*\]/g;
      text = text.replace(bare, (m) => {
        const parsed = parsePythonicList(m).filter((c) => known.has(c.name));
        if (parsed.length === 0) return m;
        calls.push(...parsed);
        return '';
      });
    } else {
      // Bare JSON object — some Qwen sizes skip the tags. Whole-output JSON
      // call shapes are accepted regardless of name (validation handles it).
      const jsonMatch = /\{[\s\S]*\}/.exec(trimmed);
      if (jsonMatch && jsonMatch[0].length >= trimmed.length * 0.8) {
        const parsed = tryParseJsonCall(jsonMatch[0]);
        if (parsed && (known.has(parsed.name) || jsonMatch[0].length === trimmed.length)) {
          calls.push(parsed);
          text = trimmed.replace(jsonMatch[0], '');
        }
      }
    }
  }

  return { text: text.trim(), reasoning, calls };
}
