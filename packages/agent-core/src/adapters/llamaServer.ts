import type { AdapterEvent, GenerateOptions, GenerationUsage, ModelAdapter } from '../adapter.js';
import type { ChatMessage } from '../types.js';
import { IM_END, IM_START, renderChatMl } from '../chatml.js';
import { policyFor } from '../policy.js';

/**
 * Raw-completion adapter for llama.cpp's `llama-server` (`POST /completion`).
 *
 * Unlike the OpenAI adapter, this sends the SAME byte-for-byte prompt the phone
 * sends (chatml.ts), so the laptop rig measures the agent that ships rather
 * than llama-server's rendering of the model's own template. Use it to A/B
 * prompt formats and models before touching the device.
 */
export interface LlamaServerConfig {
  /** e.g. http://127.0.0.1:8090 */
  baseUrl: string;
  /** Policy key, e.g. "lfm2.5-1.2b-instruct". */
  modelId: string;
}

export class LlamaServerAdapter implements ModelAdapter {
  readonly modelId: string;
  constructor(private config: LlamaServerConfig) {
    this.modelId = config.modelId;
  }

  async *generate(messages: ChatMessage[], options: GenerateOptions): AsyncIterable<AdapterEvent> {
    const policy = policyFor(this.modelId);
    const lfm = this.modelId.toLowerCase().includes('lfm');
    const mode = options.thinkingMode ?? (policy.thinking ? 'open' : 'none');
    const prompt = renderChatMl(messages, { lfm, thinking: mode });
    const res = await fetch(`${this.config.baseUrl.replace(/\/$/, '')}/completion`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt,
        n_predict: options.maxOutputTokens,
        temperature: options.temperature,
        top_p: options.topP,
        ...(options.topK !== undefined ? { top_k: options.topK } : {}),
        ...(options.repeatPenalty !== undefined ? { repeat_penalty: options.repeatPenalty } : {}),
        stop: [IM_END, IM_START, ...(options.stopSequences ?? [])],
        ...(options.grammar ? { grammar: options.grammar } : {}),
        cache_prompt: true,
        stream: false,
      }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!res.ok) {
      throw new Error(`llama-server ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    }
    const data = (await res.json()) as {
      content?: string;
      timings?: { prompt_n?: number; predicted_n?: number; prompt_per_second?: number; predicted_per_second?: number; prompt_ms?: number; predicted_ms?: number };
      tokens_cached?: number;
    };
    if (mode === 'open') yield { type: 'delta', text: '<think>' };
    yield { type: 'delta', text: data.content ?? '' };
    const t = data.timings;
    const usage: GenerationUsage = {};
    if (t) {
      if (t.prompt_n !== undefined) usage.promptTokens = t.prompt_n;
      if (t.predicted_n !== undefined) usage.completionTokens = t.predicted_n;
      if (t.prompt_per_second !== undefined) usage.promptTokensPerSec = t.prompt_per_second;
      if (t.predicted_per_second !== undefined) usage.decodeTokensPerSec = t.predicted_per_second;
      if (t.prompt_ms !== undefined) usage.promptMs = t.prompt_ms;
      if (t.predicted_ms !== undefined) usage.decodeMs = t.predicted_ms;
    }
    yield { type: 'done', usage };
  }
}
