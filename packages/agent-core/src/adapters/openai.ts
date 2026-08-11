import type { ChatMessage } from '../types.js';
import type { AdapterEvent, GenerateOptions, ModelAdapter } from '../adapter.js';

/**
 * OpenAI-compatible chat-completions adapter (SSE streaming).
 * Works against llama-server, `rcli serve`, the runanywhere-python server, or
 * any cloud endpoint. Tool calling stays HARNESS-side: messages already carry
 * the tool instructions in the system prompt, and tool results are flattened
 * to `user`-visible tool messages the way the wire format expects.
 */

export interface OpenAIAdapterConfig {
  baseUrl: string; // e.g. http://127.0.0.1:8080/v1
  apiKey?: string;
  model: string; // server-side model name
  /** Extra body fields (e.g. {"chat_template_kwargs": {"enable_thinking": false}}). */
  extraBody?: Record<string, unknown>;
}

interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

function toWire(messages: ChatMessage[]): WireMessage[] {
  const wire: WireMessage[] = [];
  for (const m of messages) {
    switch (m.role) {
      case 'system':
      case 'user':
        wire.push({ role: m.role, content: m.content });
        break;
      case 'assistant': {
        // Re-serialize tool calls into the visible text so the transcript the
        // model sees matches what it originally produced.
        let content = m.content;
        for (const call of m.toolCalls ?? []) {
          content +=
            (content ? '\n' : '') +
            `<tool_call>${JSON.stringify({ name: call.name, arguments: call.arguments })}</tool_call>`;
        }
        wire.push({ role: 'assistant', content });
        break;
      }
      case 'tool':
        // Generic chat templates lack a tool role unless tools were declared
        // server-side; encode results as a user turn with a stable envelope.
        wire.push({
          role: 'user',
          content: `<tool_response name="${m.toolName}">\n${m.content}\n</tool_response>`,
        });
        break;
    }
  }
  return wire;
}

export class OpenAIAdapter implements ModelAdapter {
  readonly modelId: string;

  constructor(private config: OpenAIAdapterConfig, modelIdOverride?: string) {
    this.modelId = modelIdOverride ?? `remote:${config.model}`;
  }

  async *generate(messages: ChatMessage[], options: GenerateOptions): AsyncIterable<AdapterEvent> {
    const url = `${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: toWire(messages),
      temperature: options.temperature,
      top_p: options.topP,
      max_tokens: options.maxOutputTokens,
      stream: true,
      ...(options.stopSequences?.length ? { stop: options.stopSequences } : {}),
      ...this.config.extraBody,
    };
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.config.apiKey) headers['authorization'] = `Bearer ${this.config.apiKey}`;

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      throw new Error(`chat/completions ${res.status}: ${detail.slice(0, 300)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let usage: { promptTokens?: number; completionTokens?: number } | undefined;
    // Servers running with reasoning parsing (llama-server --jinja) split
    // `<think>` output into delta.reasoning_content. Re-wrap it in literal
    // think tags so the harness parser sees one uniform representation.
    let inReasoning = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;
          let parsed: any;
          try {
            parsed = JSON.parse(payload);
          } catch {
            continue;
          }
          const delta = parsed.choices?.[0]?.delta ?? {};
          const reasoning = delta.reasoning_content;
          if (typeof reasoning === 'string' && reasoning.length > 0) {
            const prefix = inReasoning ? '' : '<think>';
            inReasoning = true;
            yield { type: 'delta', text: prefix + reasoning };
          }
          const content = delta.content;
          if (typeof content === 'string' && content.length > 0) {
            const prefix = inReasoning ? '</think>' : '';
            inReasoning = false;
            yield { type: 'delta', text: prefix + content };
          }
          if (parsed.usage) {
            usage = {
              promptTokens: parsed.usage.prompt_tokens,
              completionTokens: parsed.usage.completion_tokens,
            };
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
    if (inReasoning) yield { type: 'delta', text: '</think>' };
    yield { type: 'done', ...(usage ? { usage } : {}) };
  }
}
