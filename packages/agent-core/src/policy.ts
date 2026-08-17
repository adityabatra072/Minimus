import type { WireFormat } from './parsing.js';

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
  maxTurns: number;
  oneToolPerTurn: boolean;
  temperature: number;
  topP: number;
  /** Disable thinking for tool turns (speed + small-model steerability). */
  thinking: boolean;
  contextWindowTokens: number;
  maxOutputTokens: number;
  /** Cap injected tool results (chars ≈ tokens*4). */
  toolResultCharCap: number;
}

export const DEFAULT_POLICIES: ModelPolicy[] = [
  {
    // LFM2.5 is a hybrid reasoner with NO prompt-level thinking off-switch
    // ("/no_think" is Qwen-only and breaks LFM — see SDK
    // llm_thinking_directive_internal.h). Budget for the <think> block instead.
    match: 'lfm',
    format: 'pythonic',
    maxTurns: 10,
    oneToolPerTurn: true,
    temperature: 0.1,
    topP: 0.95,
    thinking: true,
    contextWindowTokens: 32768,
    // 2048 was never the binding limit: a 2048-token CONTEXT left roughly a
    // thousand tokens for output, so deliberation was cut off by the window
    // and the cap never bit. Doubling the window removed that accidental
    // brake, and the first long run showed what was underneath — a single
    // turn of `thought=8951ch text=0ch`, 2044 events, running the cap to the
    // end and producing no answer at 5 tokens/sec. That is seven minutes
    // spent on nothing.
    //
    // Sized off THINKING, not off the call. 896 was sized off the widest tool
    // call (define_macro with three steps, ~120 tokens) and that was the wrong
    // measurement: on the iPhone it cut teach-macro off mid-deliberation three
    // times, and the raw output showed the model reasoning perfectly —
    // "<think>The user is teaching me a new rule... I need to use
    // define_macro" — with no room left to emit it. Passing runs of that beat
    // spend ~1200 tokens thinking before they act.
    //
    // 1536 leaves that headroom while still bounding the runaway case (a
    // 2044-token turn of pure deliberation, seven minutes, no answer). With a
    // ~1500-token prompt it also stays clear of the 4096 window, so an
    // overrun means the model rambled rather than the context filling up.
    maxOutputTokens: 1536,
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
    contextWindowTokens: 32768,
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
    contextWindowTokens: 16384,
    maxOutputTokens: 512,
    toolResultCharCap: 6000,
  },
  // Remote/big models (rcli serve, cloud): roomier loop.
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
