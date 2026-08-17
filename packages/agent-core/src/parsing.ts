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
  // An UNCLOSED `<think>` means generation stopped mid-thought (cancelled, or
  // the budget ran out). Everything after it is reasoning — never answer text.
  // Without this a cancelled run rendered a literal "<think>" bubble in chat.
  const open = text.indexOf('<think>');
  if (open !== -1) {
    reasoning += text.slice(open + '<think>'.length).trim() + '\n';
    text = text.slice(0, open);
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
 * Convert a Python-flavoured literal to JSON: single-quoted strings and the
 * `True`/`False`/`None` keywords.
 *
 * Naive `.replace(/'/g, '"')` is not enough and the difference is not
 * cosmetic: LFM2.5 emits nested arguments as
 * `steps=[{'tool': 'flashlight', 'arguments': {'on': False}}]`, and a bare
 * `False` makes JSON.parse throw — which silently dropped the whole tool call
 * and made a correct model look broken. Walks the string so quotes and
 * keywords inside string values are left alone.
 */
function pythonishToJson(src: string): string {
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quote) {
      if (c === '\\') {
        out += c + (src[i + 1] ?? '');
        i++;
      } else if (c === quote) {
        out += '"';
        quote = null;
      } else if (c === '"') {
        out += '\\"'; // inner double quote inside a single-quoted string
      } else {
        out += c;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      out += '"';
      continue;
    }
    const keyword = /^(True|False|None)\b/.exec(src.slice(i))?.[1];
    if (keyword) {
      out += keyword === 'True' ? 'true' : keyword === 'False' ? 'false' : 'null';
      i += keyword.length - 1;
      continue;
    }
    out += c;
  }
  return out;
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
      try {
        args[key] = JSON.parse(pythonishToJson(argsSrc.slice(start, i)));
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
  // Accepts a single list `[a(), b()]` AND concatenated lists `[a()][b()]` —
  // a model batching several actions emits the latter, and treating it as
  // prose leaks raw tool syntax into the chat as a "final answer".
  const inner = src.trim().replace(/^\[/, '').replace(/\]$/, '');
  const calls: ParsedCall[] = [];
  let depth = 0;
  let inString: string | null = null;
  let start = 0;
  const flush = (end: number) => {
    const piece = inner.slice(start, end);
    if (piece.trim()) {
      const parsed = tryParsePythonicCall(piece);
      if (parsed) calls.push(parsed);
    }
  };
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!;
    if (inString) {
      if (c === '\\') i++;
      else if (c === inString) inString = null;
      continue;
    }
    if (c === '"' || c === "'") inString = c;
    else if (c === '(' || c === '{') depth++;
    else if (c === ')' || c === '}') depth--;
    else if (c === '[') {
      // Inside arguments it's a list literal; at top level it opens the NEXT
      // concatenated call list — either way the piece so far is complete.
      if (depth > 0) depth++;
      else {
        flush(i);
        start = i + 1;
      }
    } else if (c === ']') {
      if (depth > 0) depth--;
      else {
        flush(i);
        start = i + 1;
      }
    } else if (c === ',' && depth === 0) {
      flush(i);
      start = i + 1;
    }
  }
  flush(inner.length);
  return calls;
}

/**
 * A call the model never closed: `[define_macro(...)` with the list bracket
 * missing, or a bare `define_macro(...)` with no brackets at all.
 *
 * Device evidence (iPhone 15, teach-macro): the model emitted a complete and
 * correct define_macro whose only defect was the absent final `]`, and the
 * turn was reported as "no tools" — the model did the work and got a retry
 * for a punctuation slip, at 100 seconds a turn. Gated on a KNOWN tool name,
 * so prose like "[see note(1)" is never promoted into a call.
 */
function salvageUnclosedCall(trimmed: string, known: Set<string>): ParsedCall | null {
  const m = /^\[?\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\([\s\S]*\)\s*$/.exec(trimmed);
  if (!m || !known.has(m[1]!)) return null;
  return tryParsePythonicCall(trimmed.replace(/^\[/, ''));
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
    const salvaged =
      format === 'pythonic' && !wholePythonic ? salvageUnclosedCall(trimmed, known) : null;
    if (format === 'pythonic' && wholePythonic) {
      const parsed = parsePythonicList(trimmed);
      if (parsed.length > 0) {
        calls.push(...parsed);
        text = '';
      }
    } else if (salvaged) {
      calls.push(salvaged);
      text = '';
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
