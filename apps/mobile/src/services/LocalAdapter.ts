import type {
  AdapterEvent,
  ChatMessage,
  GenerateOptions,
  ModelAdapter,
} from '@minimus/agent-core';
import { policyFor, renderChatMl } from '@minimus/agent-core';
import { engine } from './engine';
import { diag } from './diag';
import { deviceHealth } from './health';

/**
 * ModelAdapter over the on-device engine (services/engine.ts, llama.rn).
 *
 * The adapter renders the FULL ChatML transcript itself and hands it to the
 * engine verbatim. LFM2.5's own jinja template forces `<think>` open on every
 * assistant turn and mis-renders multi-turn tool history, and Qwen is
 * ChatML-native, so one formatter serves every catalog model and the harness
 * stays in charge of what the model sees.
 *
 * Tool calling stays HARNESS-side (agent-core parses the raw text), identical
 * to the laptop eval rig.
 */

const IM_START = '<|im_start|>';
const IM_END = '<|im_end|>';

export class LocalAdapter implements ModelAdapter {
  constructor(
    readonly modelId: string,
    /** 'router' runs on the engine's dedicated classification lane. */
    private readonly lane: 'main' | 'router' = 'main',
  ) {}

  async *generate(messages: ChatMessage[], options: GenerateOptions): AsyncIterable<AdapterEvent> {
    const lfm = this.modelId.toLowerCase().includes('lfm');
    const policy = policyFor(this.modelId);
    const mode = options.thinkingMode ?? (policy.thinking ? 'open' : 'none');
    const thinking = mode === 'open';
    const prompt = renderChatMl(messages, { lfm, thinking: mode });
    // A hot phone throttles the GPU to a quarter of its speed (24 → 6 tok/s
    // measured). Long deliberation is what generates the heat, so when the
    // OS reports thermal pressure the thinking budget shrinks: shorter turns,
    // less heat, and the answer still arrives.
    let budget = options.thinkingBudgetTokens;
    if (this.lane === 'main' && thinking && budget !== undefined) {
      const health = await deviceHealth();
      if (health.thermal === 'critical') budget = Math.min(budget, 96);
      else if (health.thermal === 'serious') budget = Math.min(budget, 192);
      if (budget !== options.thinkingBudgetTokens) diag(`thermal ${health.thermal}: thinking budget ${options.thinkingBudgetTokens} → ${budget}`);
    }
    if (this.lane === 'router') {
      const r = await engine.classify(prompt, options.grammar ?? '', options.maxOutputTokens, options.signal);
      yield { type: 'delta', text: r.text };
      yield { type: 'done', usage: r.usage };
      return;
    }
    diag(`generate start model=${this.modelId} promptChars=${prompt.length} think=${mode}`);

    // The engine calls back per token; the harness wants an async iterable.
    // Bridge with a queue so tokens flow while the completion is in flight.
    const queue: string[] = [];
    let wake: (() => void) | null = null;
    let finished = false;
    let failure: unknown = null;
    let result: Awaited<ReturnType<typeof engine.complete>> | null = null;
    const push = (text: string) => {
      queue.push(text);
      wake?.();
    };
    const run = engine
      .complete(
        prompt,
        {
          maxTokens: options.maxOutputTokens,
          temperature: options.temperature,
          topP: options.topP,
          ...(options.topK !== undefined ? { topK: options.topK } : {}),
          ...(options.repeatPenalty !== undefined ? { repeatPenalty: options.repeatPenalty } : {}),
          stop: [IM_END, IM_START, ...(options.stopSequences ?? [])],
          ...(thinking && budget !== undefined ? { thinkingBudgetTokens: budget, thinkingForcedOpen: true } : {}),
          ...(options.grammar ? { grammar: options.grammar } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        },
        push,
      )
      .then((r) => {
        result = r;
      })
      .catch((err: unknown) => {
        failure = err;
      })
      .finally(() => {
        finished = true;
        wake?.();
      });

    // The prompt pre-opened <think>; surface the opening tag so the harness
    // sees a complete block when the model closes it.
    if (thinking) yield { type: 'delta', text: '<think>' };
    let emitted = 0;
    while (true) {
      while (queue.length > 0) {
        const text = queue.shift()!;
        emitted += text.length;
        yield { type: 'delta', text };
      }
      if (finished) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      wake = null;
    }
    await run;
    if (failure) {
      if (options.signal?.aborted) {
        yield { type: 'done' };
        return;
      }
      throw failure instanceof Error ? failure : new Error(String(failure));
    }
    if (result) {
      const r = result as Awaited<ReturnType<typeof engine.complete>>;
      // A generation the sampler cut at the output cap while still inside
      // <think> has no closing tag; the harness treats an unclosed block as
      // reasoning-only, which is the correct reading.
      if (r.stoppedBy === 'context_full') {
        diag('gen hit the context window — the harness will compact');
      }
      yield { type: 'done', usage: r.usage };
    } else {
      yield { type: 'done' };
    }
    void emitted;
  }
}
