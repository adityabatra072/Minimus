import { RunAnywhere } from '@runanywhere/core';
import { diag } from './diag';
import type {
  AdapterEvent,
  ChatMessage,
  GenerateOptions,
  ModelAdapter,
} from '@minimus/agent-core';

/**
 * ModelAdapter over the on-device RunAnywhere SDK.
 *
 * The adapter formats the FULL ChatML transcript itself and sends it as a
 * string prompt. The llama.cpp backend passes pre-templated prompts through
 * VERBATIM when they contain `<|im_start|>` (build_prompt, llamacpp_backend
 * .cpp) — which sidesteps a real on-device failure: LFM2.5's jinja template
 * is unknown to llama_chat_apply_template (result=-1), and the "role:
 * content" fallback makes the model emit EOS after ~9 tokens. Both LFM2/2.5
 * and Qwen are ChatML-native, so one formatter serves every catalog model.
 *
 * Tool calling stays HARNESS-side (agent-core parses the raw text), identical
 * to the Windows eval rig.
 */

const IM_START = '<|im_start|>';
const IM_END = '<|im_end|>';

/** Render one argument value the way LFM2.5's own template does. */
function lfmArgValue(value: unknown): string {
  if (typeof value === 'string') {
    return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r')}'`;
  }
  if (value !== null && typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function toChatMl(messages: ChatMessage[], lfm: boolean): string {
  let out = '';
  const turn = (role: string, content: string) => {
    out += `${IM_START}${role}\n${content}${IM_END}\n`;
  };
  for (const m of messages) {
    switch (m.role) {
      case 'system':
        turn('system', m.content);
        break;
      case 'user':
        turn('user', m.content);
        break;
      case 'assistant': {
        let content = m.content;
        for (const call of m.toolCalls ?? []) {
          if (lfm) {
            // LFM2.5's template renders history calls in its own pythonic
            // wrapper — Hermes-style JSON here is off-distribution.
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
        if (lfm) {
          // The LFM template renders any role verbatim: tool results are a
          // plain `tool` turn, not a user-wrapped envelope.
          turn('tool', m.content);
        } else {
          turn('user', `<tool_response name="${m.toolName}">\n${m.content}\n</tool_response>`);
        }
        break;
    }
  }
  // THE line that ended a week of silent-turn hunts: LFM2.5's generation
  // prompt is `<|im_start|>assistant\n<think>` — thinking FORCED OPEN by the
  // template. Without the prefill the model is off-distribution and often
  // emits EOS instead of deliberating; the rig never saw it because
  // llama-server applies the real template.
  out += lfm ? `${IM_START}assistant\n<think>` : `${IM_START}assistant\n`;
  return out;
}

export class LocalAdapter implements ModelAdapter {
  constructor(readonly modelId: string) {}

  async *generate(
    messages: ChatMessage[],
    options: GenerateOptions,
  ): AsyncIterable<AdapterEvent> {
    const lfm = this.modelId.toLowerCase().includes('lfm');
    const prompt = toChatMl(messages, lfm);
    console.log(`[minimus] generate start model=${this.modelId} promptChars=${prompt.length}`);
    const stream = RunAnywhere.llm.generateStream(prompt, {
      model: this.modelId,
      temperature: options.temperature,
      topP: options.topP,
      maxOutputTokens: options.maxOutputTokens,
      // THE week-long "silent turn" bug: with reasoning unset the runtime
      // STRIPS thought spans from the stream — a turn the model spent
      // thinking surfaced as zero events and read as instant-EOS
      // (gen END: events=2 thought=0 text=0 on a 69s generation). The
      // harness owns think-tag parsing, so ask for thoughts verbatim.
      reasoning: { mode: 'on', includeInOutput: true },
      // Stop on the next turn header: with a verbatim prompt the model owns
      // turn boundaries, and some models keep writing the next turn.
      stopSequences: [IM_END, IM_START, ...(options.stopSequences ?? [])],
    });

    // The prompt pre-opened <think> for LFM — surface the opening tag to the
    // harness so extractReasoning sees a complete block when the model closes
    // it with its own </think>.
    if (lfm) yield { type: 'delta', text: '<think>' };
    let inThinking = false;
    // Stream forensics: rig A/B proved the silent turns are runtime-specific,
    // not prompt-text — so the stream itself must testify. Counts by kind +
    // how it ended, one syslog line per generation.
    let thoughtChars = 0;
    let textChars = 0;
    let endReason = 'iterator-exhausted';
    let eventCount = 0;
    for await (const event of stream) {
      eventCount += 1;
      if (eventCount === 1 || eventCount % 100 === 0) {
        console.log(`[minimus] stream event #${eventCount}: ${event.type}`);
      }
      if (options.signal?.aborted) {
        // Exiting the for-await closes the SDK's pushStream, which cancels
        // the native generation.
        break;
      }
      switch (event.type) {
        case 'token': {
          if (event.kind === 'thought') {
            thoughtChars += event.text.length;
            const prefix = inThinking ? '' : '<think>';
            inThinking = true;
            yield { type: 'delta', text: prefix + event.text };
          } else {
            textChars += event.text.length;
            const prefix = inThinking ? '</think>' : '';
            inThinking = false;
            yield { type: 'delta', text: prefix + event.text };
          }
          break;
        }
        case 'failed':
          endReason = 'failed';
          diag(
            `gen END ${endReason}: events=${eventCount} thought=${thoughtChars}ch text=${textChars}ch`,
          );
          throw event.error;
        case 'completed':
          endReason = 'completed';
          break;
        default:
          break;
      }
    }
    if (options.signal?.aborted) endReason = 'aborted';
    diag(
      `gen END ${endReason}: events=${eventCount} thought=${thoughtChars}ch text=${textChars}ch promptChars=${prompt.length}`,
    );
    if (inThinking) yield { type: 'delta', text: '</think>' };
    yield { type: 'done' };
  }
}
