import type { ChatMessage } from './types.js';

/**
 * Renders the harness transcript into the raw ChatML prompt the on-device
 * engine (and the laptop rig, via llama-server's raw completion endpoint)
 * receives VERBATIM. Living in agent-core means the phone and the rig send
 * byte-identical prompts, so a rig result transfers to the device.
 *
 * Two dialects share the ChatML envelope:
 *  - LFM2.5 / LFM2: tool calls are rendered in the model's pythonic wrapper
 *    (`<|tool_call_start|>[f(a='x')]<|tool_call_end|>`), tool results are a
 *    plain `tool` turn, and thinking models open the assistant turn with
 *    `<think>` because their template forces it.
 *  - Qwen (Hermes): JSON `<tool_call>` blocks and `<tool_response>` wrappers
 *    inside a user turn.
 */

export const IM_START = '<|im_start|>';
export const IM_END = '<|im_end|>';

export type ThinkingMode =
  /** Open `<think>` for the model to fill (the LFM2.5 template's own behaviour). */
  | 'open'
  /** Prefill an EMPTY think block so a forced-thinking model skips deliberation this turn. */
  | 'closed'
  /** No think tag at all (models whose template never thinks). */
  | 'none';

export interface RenderOptions {
  /** Pythonic LFM wire format (else Hermes JSON). */
  lfm: boolean;
  /**
   * Whether to prefill `<think>`. `true` = 'open', `false` = 'none'.
   * 'closed' is the fast path for LFM2.5-2.6B: measured on the rig, the same
   * five requests took 6.4s with a closed block and 21s with an open one, and
   * the tool calls were the same.
   */
  thinking: boolean | ThinkingMode;
}

/** Render one argument value the way LFM2.5's own template does. */
export function lfmArgValue(value: unknown): string {
  if (typeof value === 'string') {
    return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r')}'`;
  }
  if (value !== null && typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function renderChatMl(messages: ChatMessage[], opts: RenderOptions): string {
  let out = '';
  const turn = (role: string, content: string) => {
    out += `${IM_START}${role}\n${content}${IM_END}\n`;
  };
  // LFM2.5's template keeps the thinking of assistant turns that come AFTER
  // the last user message and strips earlier ones. Inside an agent run every
  // tool turn is after the user's message, so keeping that thinking is what
  // the model was trained on, and it keeps the re-rendered history
  // token-identical to what the model generated, which the engine's prefix
  // cache needs in order to skip re-prefilling it.
  const mode: ThinkingMode = opts.thinking === true ? 'open' : opts.thinking === false ? 'none' : opts.thinking;
  let lastUserIndex = -1;
  messages.forEach((m, i) => {
    if (m.role === 'user') lastUserIndex = i;
  });
  messages.forEach((m, i) => {
    switch (m.role) {
      case 'system':
        turn('system', m.content);
        break;
      case 'user':
        turn('user', m.content);
        break;
      case 'assistant': {
        let content = '';
        if (mode !== 'none' && m.reasoning && i > lastUserIndex) {
          content += `<think>${m.reasoning}</think>`;
        }
        content += m.content;
        for (const call of m.toolCalls ?? []) {
          if (opts.lfm) {
            const args = Object.entries(call.arguments)
              .map(([k, v]) => `${k}=${lfmArgValue(v)}`)
              .join(', ');
            content += `<|tool_call_start|>[${call.name}(${args})]<|tool_call_end|>`;
          } else {
            content +=
              (content ? '\n' : '') +
              `<tool_call>${JSON.stringify({ name: call.name, arguments: call.arguments })}</tool_call>`;
          }
        }
        turn('assistant', content);
        break;
      }
      case 'tool':
        if (opts.lfm) {
          turn('tool', m.content);
        } else {
          turn('user', `<tool_response name="${m.toolName}">\n${m.content}\n</tool_response>`);
        }
        break;
    }
  });
  out +=
    mode === 'open'
      ? `${IM_START}assistant\n<think>`
      : mode === 'closed'
        ? `${IM_START}assistant\n<think>\n</think>\n`
        : `${IM_START}assistant\n`;
  return out;
}
