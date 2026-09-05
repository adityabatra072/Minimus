import type { WireFormat } from './parsing.js';
import type { ToolListFormat } from './prompts.js';

/**
 * Per-model behavior table. Small on-device models get a constrained harness
 * (one tool per turn, low temperature, short answers); bigger/remote models
 * relax those limits. Evidence: BFCL multi-turn accuracy collapses below ~3B,
 * and parallel-call categories score measurably worse for small models.
 */
export interface ModelPolicy {
  /** Substring matched (case-insensitive) against the model id. */
  match: string;
  format: WireFormat;
  /** Tool list rendering in the system prompt (default compact). */
  toolFormat?: ToolListFormat;
  maxTurns: number;
  oneToolPerTurn: boolean;
  temperature: number;
  topP: number;
  topK?: number;
  repeatPenalty?: number;
  /**
   * The model deliberates inside <think> before answering. For LFM2.5-2.6B
   * this is forced open by its own chat template and cannot be switched off
   * from the prompt; the adapter prefills the tag and the harness budgets it.
   */
  thinking: boolean;
  /** Cap on thinking tokens per turn (engines that can enforce it do). */
  thinkingBudgetTokens?: number;
  /**
   * 'always': open the think block on every turn (the model's own template).
   * 'adaptive': think only when the composition flagged the request as
   * needing judgment, or after a fast turn went wrong; otherwise prefill a
   * closed block. Rig evidence (LFM2.5-2.6B): 3.3x faster on plain requests
   * with the same tool calls.
   */
  thinkingStrategy?: 'always' | 'adaptive' | 'adaptive-fast';
  contextWindowTokens: number;
  maxOutputTokens: number;
  /** Cap injected tool results (chars ≈ tokens*4). */
  toolResultCharCap: number;
}

export const DEFAULT_POLICIES: ModelPolicy[] = [
  {
    // LFM2.5-1.2B-Instruct: no thinking block at all (its template opens the
    // assistant turn bare), tuned for function calling. A tool-call turn is
    // ~30 output tokens, which is why it is the fast default on a phone.
    match: 'lfm2.5-1.2b',
    format: 'pythonic',
    toolFormat: 'lfm-json',
    maxTurns: 10,
    oneToolPerTurn: true,
    temperature: 0.1,
    topP: 0.95,
    topK: 50,
    repeatPenalty: 1.05,
    thinking: false,
    contextWindowTokens: 8192,
    maxOutputTokens: 512,
    toolResultCharCap: 6000,
  },
  {
    // LFM2-1.2B-Tool: purpose-built for tool calls, no thinking.
    match: 'lfm2-1.2b-tool',
    format: 'pythonic',
    toolFormat: 'lfm-json',
    maxTurns: 10,
    oneToolPerTurn: true,
    temperature: 0.1,
    topP: 0.95,
    topK: 50,
    repeatPenalty: 1.05,
    thinking: false,
    contextWindowTokens: 8192,
    maxOutputTokens: 384,
    toolResultCharCap: 6000,
  },
  {
    // LFM2.5-2.6B is a hybrid reasoner whose template forces <think> open.
    // Device history: an unbudgeted turn spent 2044 tokens deliberating and
    // produced no answer (seven minutes on CPU). The engine-enforced budget
    // closes the block at 512 tokens, which is above the ~300 a passing
    // teach-macro run actually needs and far below the runaway case.
    match: 'lfm',
    format: 'pythonic',
    maxTurns: 10,
    oneToolPerTurn: true,
    temperature: 0.1,
    topP: 0.95,
    topK: 50,
    repeatPenalty: 1.1,
    thinking: true,
    // 384 rather than 512: on the phone every thinking token is heat, and the
    // passing teach runs settled at ~300 tokens of deliberation.
    thinkingBudgetTokens: 384,
    thinkingStrategy: 'adaptive',
    contextWindowTokens: 8192,
    maxOutputTokens: 768,
    toolResultCharCap: 6000,
  },
  {
    match: 'qwen3.5',
    format: 'hermes',
    maxTurns: 10,
    oneToolPerTurn: true,
    temperature: 0.1,
    topP: 0.95,
    thinking: false,
    contextWindowTokens: 8192,
    maxOutputTokens: 768,
    toolResultCharCap: 6000,
  },
  {
    match: 'qwen',
    format: 'hermes',
    maxTurns: 10,
    oneToolPerTurn: true,
    temperature: 0.1,
    topP: 0.95,
    thinking: false,
    contextWindowTokens: 8192,
    maxOutputTokens: 512,
    toolResultCharCap: 6000,
  },
  // Remote/big models (llama-server, cloud): roomier loop.
  {
    match: 'remote:',
    format: 'hermes',
    maxTurns: 20,
    oneToolPerTurn: false,
    temperature: 0.3,
    topP: 0.95,
    thinking: true,
    contextWindowTokens: 128000,
    maxOutputTokens: 4096,
    toolResultCharCap: 20000,
  },
];

export const FALLBACK_POLICY: ModelPolicy = {
  match: '',
  format: 'hermes',
  maxTurns: 10,
  oneToolPerTurn: true,
  temperature: 0.1,
  topP: 0.95,
  thinking: false,
  contextWindowTokens: 8192,
  maxOutputTokens: 512,
  toolResultCharCap: 6000,
};

export function policyFor(modelId: string, policies: ModelPolicy[] = DEFAULT_POLICIES): ModelPolicy {
  const id = modelId.toLowerCase();
  for (const p of policies) {
    if (p.match && id.includes(p.match)) return p;
  }
  return FALLBACK_POLICY;
}
