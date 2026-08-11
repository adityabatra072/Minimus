import { RunAnywhere } from '@runanywhere/core';
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

function toChatMl(messages: ChatMessage[]): string {
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
          content +=
            (content ? '\n' : '') +
            `<tool_call>${JSON.stringify({ name: call.name, arguments: call.arguments })}</tool_call>`;
        }
        turn('assistant', content);
        break;
      }
      case 'tool':
        // ChatML has no tool role that every model understands — deliver the
        // result as a user turn with a stable envelope (same as eval rig).
        turn('user', `<tool_response name="${m.toolName}">\n${m.content}\n</tool_response>`);
        break;
    }
  }
  out += `${IM_START}assistant\n`;
  return out;
}

export class LocalAdapter implements ModelAdapter {
  constructor(readonly modelId: string) {}

  async *generate(
    messages: ChatMessage[],
    options: GenerateOptions,
  ): AsyncIterable<AdapterEvent> {
    const prompt = toChatMl(messages);
    console.log(`[minimus] generate start model=${this.modelId} promptChars=${prompt.length}`);
    const stream = RunAnywhere.llm.generateStream(prompt, {
      model: this.modelId,
      temperature: options.temperature,
      topP: options.topP,
      maxOutputTokens: options.maxOutputTokens,
      // Stop on the next turn header: with a verbatim prompt the model owns
      // turn boundaries, and some models keep writing the next turn.
      stopSequences: [IM_END, IM_START, ...(options.stopSequences ?? [])],
    });

    let inThinking = false;
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
            const prefix = inThinking ? '' : '<think>';
            inThinking = true;
            yield { type: 'delta', text: prefix + event.text };
          } else {
            const prefix = inThinking ? '</think>' : '';
            inThinking = false;
            yield { type: 'delta', text: prefix + event.text };
          }
          break;
        }
        case 'failed':
          throw event.error;
        case 'completed':
          console.log(`[minimus] stream completed after ${eventCount} events`);
          break;
        default:
          break;
      }
    }
    if (inThinking) yield { type: 'delta', text: '</think>' };
    yield { type: 'done' };
  }
}
