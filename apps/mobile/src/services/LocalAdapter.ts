import { RunAnywhere, type ChatMessage as SdkChatMessage } from '@runanywhere/core';
import type {
  AdapterEvent,
  ChatMessage,
  GenerateOptions,
  ModelAdapter,
} from '@minimus/agent-core';

/**
 * ModelAdapter over the on-device RunAnywhere SDK.
 *
 * Uses `llm.generateStream` WITHOUT SDK-side tools: the agent-core loop owns
 * tool parsing/execution (identical behavior to the Windows eval rig), and the
 * SDK's own tool loop would otherwise swallow the raw call text. Thought
 * tokens are re-wrapped in literal <think> tags — one uniform representation
 * for the harness parser.
 */

function toSdkMessages(messages: ChatMessage[]): {
  history: SdkChatMessage[];
  systemPrompt?: string;
} {
  const history: SdkChatMessage[] = [];
  let systemPrompt: string | undefined;
  for (const m of messages) {
    switch (m.role) {
      case 'system':
        systemPrompt = m.content;
        break;
      case 'user':
        history.push({ role: 'user', content: m.content });
        break;
      case 'assistant': {
        let content = m.content;
        for (const call of m.toolCalls ?? []) {
          content +=
            (content ? '\n' : '') +
            `<tool_call>${JSON.stringify({ name: call.name, arguments: call.arguments })}</tool_call>`;
        }
        history.push({ role: 'assistant', content });
        break;
      }
      case 'tool':
        history.push({
          role: 'user',
          content: `<tool_response name="${m.toolName}">\n${m.content}\n</tool_response>`,
        });
        break;
    }
  }
  return systemPrompt !== undefined ? { history, systemPrompt } : { history };
}

export class LocalAdapter implements ModelAdapter {
  constructor(readonly modelId: string) {}

  async *generate(
    messages: ChatMessage[],
    options: GenerateOptions,
  ): AsyncIterable<AdapterEvent> {
    const { history, systemPrompt } = toSdkMessages(messages);
    const stream = RunAnywhere.llm.generateStream(history, {
      model: this.modelId,
      temperature: options.temperature,
      topP: options.topP,
      maxOutputTokens: options.maxOutputTokens,
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
      ...(options.stopSequences?.length ? { stopSequences: options.stopSequences } : {}),
    });

    let inThinking = false;
    for await (const event of stream) {
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
          break;
        default:
          break;
      }
    }
    if (inThinking) yield { type: 'delta', text: '</think>' };
    yield { type: 'done' };
  }
}
