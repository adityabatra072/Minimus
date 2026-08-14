import type { ChatMessage } from './types.js';

/**
 * ModelAdapter — the only surface the loop uses to talk to a model.
 *
 * Implementations:
 *  - LocalAdapter (apps/mobile): RunAnywhere RN SDK `llm.generateStream`.
 *  - OpenAIAdapter (here): any OpenAI-compatible /v1/chat/completions endpoint
 *    (llama-server, rcli serve, runanywhere-python server, cloud).
 *  - MockAdapter (tests/eval): scripted outputs.
 *
 * Adapters return RAW TEXT deltas. Tool-call parsing is owned by the harness
 * (parsing.ts) so behavior is identical across engines and platforms.
 */

export interface GenerateOptions {
  temperature: number;
  topP: number;
  maxOutputTokens: number;
  stopSequences?: string[];
  signal?: AbortSignal;
  /**
   * Force the model to answer WITHOUT deliberating this turn — set by the
   * loop after a thinking-overrun retry. Adapters for models with prompt-
   * level thinking scaffolds (LFM) pre-close the think block; others ignore.
   */
  suppressThinking?: boolean;
}

export type AdapterEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; usage?: { promptTokens?: number; completionTokens?: number } };

export interface ModelAdapter {
  /** Stable id used for policy lookup (e.g. "lfm2.5-2.6b", "remote:qwen3.6-27b"). */
  readonly modelId: string;
  generate(messages: ChatMessage[], options: GenerateOptions): AsyncIterable<AdapterEvent>;
}
