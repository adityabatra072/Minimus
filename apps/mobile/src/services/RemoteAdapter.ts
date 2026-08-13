import type {
  AdapterEvent,
  ChatMessage,
  GenerateOptions,
  ModelAdapter,
} from '@minimus/agent-core';

/**
 * OpenAI-compatible adapter for React Native. agent-core's OpenAIAdapter
 * streams over SSE via response.body.getReader(), which RN's fetch does not
 * implement — so this adapter requests stream:false and yields the complete
 * text as one delta. The harness doesn't care (it parses the assembled turn);
 * only token-by-token rendering is lost, and the chat UI never renders raw
 * tokens anyway.
 */

export interface RemoteConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
}

function toWire(messages: ChatMessage[]) {
  return messages.map((m) => {
    switch (m.role) {
      case 'tool':
        return {
          role: 'user' as const,
          content: `<tool_response name="${m.toolName}">\n${m.content}\n</tool_response>`,
        };
      case 'assistant': {
        let content = m.content;
        for (const call of m.toolCalls ?? []) {
          content +=
            (content ? '\n' : '') +
            `<tool_call>${JSON.stringify({ name: call.name, arguments: call.arguments })}</tool_call>`;
        }
        return { role: 'assistant' as const, content };
      }
      default:
        return { role: m.role, content: m.content };
    }
  });
}

export class RemoteAdapter implements ModelAdapter {
  readonly modelId: string;

  constructor(private config: RemoteConfig) {
    this.modelId = `remote:${config.model}`;
  }

  async *generate(
    messages: ChatMessage[],
    options: GenerateOptions,
  ): AsyncIterable<AdapterEvent> {
    const url = `${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.config.apiKey) headers['authorization'] = `Bearer ${this.config.apiKey}`;

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: this.config.model,
        messages: toWire(messages),
        temperature: options.temperature,
        top_p: options.topP,
        max_tokens: options.maxOutputTokens,
        stream: false,
        ...(options.stopSequences?.length ? { stop: options.stopSequences } : {}),
      }),
      signal: options.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`remote endpoint ${res.status}: ${detail.slice(0, 200)}`);
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string; reasoning_content?: string } }[];
    };
    const msg = data.choices?.[0]?.message;
    if (msg?.reasoning_content) yield { type: 'delta', text: `<think>${msg.reasoning_content}</think>` };
    yield { type: 'delta', text: msg?.content ?? '' };
    yield { type: 'done' };
  }
}
