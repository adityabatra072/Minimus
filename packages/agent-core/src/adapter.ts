import type { ChatMessage } from './types.js';

/**
 * ModelAdapter — the only surface the loop uses to talk to a model.
 *
 * Implementations:
 *  - LocalAdapter (apps/mobile): llama.rn (llama.cpp with Metal) on device.
 *  - OpenAIAdapter (here): any OpenAI-compatible /v1/chat/completions endpoint
 *    (llama-server, cloud).
 *  - MockAdapter (tests/eval): scripted outputs.
 *
 * Adapters return RAW TEXT deltas. Tool-call parsing is owned by the harness
 * (parsing.ts) so behavior is identical across engines and platforms.
 */

export interface GenerateOptions {
  temperature: number;
  topP: number;
  /** Top-k sampling; omit for the engine default. */
  topK?: number;
  /** Repetition penalty (1.0 = off). LFM2.5 recommends 1.05 to 1.1. */
  repeatPenalty?: number;
  maxOutputTokens: number;
  /**
   * Hard cap on the tokens a thinking model may spend inside <think>. Engines
   * that support it force the block closed at the cap, which turns a
   * seven-minute deliberation spiral into a bounded cost. Ignored by adapters
   * whose engine cannot enforce it.
   */
  thinkingBudgetTokens?: number;
  /**
   * Per-turn thinking control decided by the loop (see policy.thinkingStrategy).
   * 'closed' prefills an empty think block so a forced-thinking model answers
   * directly this turn. Adapters fall back to the policy default when unset.
   */
  thinkingMode?: 'open' | 'closed' | 'none';
  /** GBNF grammar constraining the output (engines that support it). */
  grammar?: string;
  stopSequences?: string[];
  signal?: AbortSignal;
}

/** Per-generation numbers the UI and the diagnostics surface. */
export interface GenerationUsage {
  promptTokens?: number;
  /** Prompt tokens served from the engine's KV/state cache (no prefill paid). */
  cachedTokens?: number;
  completionTokens?: number;
  promptMs?: number;
  decodeMs?: number;
  promptTokensPerSec?: number;
  decodeTokensPerSec?: number;
}

export type AdapterEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; usage?: GenerationUsage };

export interface ModelAdapter {
  /** Stable id used for policy lookup (e.g. "lfm2.5-2.6b", "remote:qwen3.6-27b"). */
  readonly modelId: string;
  generate(messages: ChatMessage[], options: GenerateOptions): AsyncIterable<AdapterEvent>;
}
