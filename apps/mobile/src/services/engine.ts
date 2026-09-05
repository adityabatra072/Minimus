import { Platform } from 'react-native';
import DeviceInfo from 'react-native-device-info';
import {
  initLlama,
  releaseAllLlama,
  addNativeLogListener,
  toggleNativeLog,
  type LlamaContext,
  type CompletionParams,
  type ContextParams,
  type NativeCompletionResult,
} from 'llama.rn';
import type { GenerationUsage } from '@minimus/agent-core';
import { findModel, modelPath, type ModelSpec } from './models';
import { diag } from './diag';
import { deviceHealth, healthLine } from './health';

/**
 * The inference engine: llama.cpp through llama.rn, GPU-first.
 *
 * Why this replaced the previous SDK's llama backend (docs/SDK-FINDINGS.md):
 * that binary loaded every model at a 2048-token cap because the context
 * option never reached it, cleared the KV cache before every generation so a
 * ten-turn agent run paid full prefill ten times, and exposed no thread, GPU
 * or thinking-budget knobs. Here:
 *
 *  - Metal runs the model (n_gpu_layers = all). On an iPhone 15 that is the
 *    difference between a CPU that throttles after two turns and a GPU that
 *    finishes the run.
 *  - The prompt prefix is cached across generations, including for LFM2.5,
 *    which is a hybrid (recurrent + attention) model whose state cannot be
 *    rewound: llama.rn snapshots the recurrent state at message boundaries
 *    and restores the longest snapshot that still prefixes the new prompt.
 *  - The thinking budget is enforced by the sampler, not by asking nicely.
 *
 * One context at a time. The phone has one GPU and one memory budget.
 */

export interface EnginePrefs {
  /** Offload every layer to the GPU (Metal). Off = CPU only. */
  gpu: boolean;
  /** Context window in tokens. */
  contextTokens: number;
  /** CPU threads for the CPU path and for the parts Metal leaves on CPU. 0 = auto. */
  threads: number;
  /** Quantise the KV cache to q8_0 (halves KV memory; needs flash attention). */
  kvQuant: boolean;
}

export const DEFAULT_ENGINE_PREFS: EnginePrefs = {
  gpu: true,
  contextTokens: 8192,
  threads: 0,
  kvQuant: false,
};

export interface EngineInfo {
  modelId: string;
  desc: string;
  paramsB: number;
  gpu: boolean;
  reasonNoGPU: string;
  isHybrid: boolean;
  contextTokens: number;
  threads: number;
  loadMs: number;
}

export interface CompleteOptions {
  maxTokens: number;
  temperature: number;
  topP: number;
  topK?: number;
  repeatPenalty?: number;
  stop: string[];
  /** Force-close the <think> block after this many tokens. */
  thinkingBudgetTokens?: number;
  /** The prompt already ends inside an open <think> (LFM2.5 template). */
  thinkingForcedOpen?: boolean;
  /** GBNF grammar constraining the output. */
  grammar?: string;
  signal?: AbortSignal;
}

export interface CompleteResult {
  text: string;
  usage: GenerationUsage;
  stoppedBy: 'eos' | 'stop' | 'limit' | 'cancelled' | 'context_full';
}

type Listener = (state: EngineState) => void;

export type EngineState =
  | { status: 'unloaded' }
  | { status: 'loading'; modelId: string; progress: number }
  | { status: 'ready'; info: EngineInfo }
  | { status: 'error'; modelId: string; message: string };

function autoThreads(): number {
  // Performance cores only: iPhone 15 has 2P + 4E, and putting decode work on
  // the efficiency cores makes the whole batch wait for the slowest one.
  // llama.cpp picks n_threads from the total core count otherwise.
  if (Platform.OS === 'ios') return 4;
  return 4;
}

export type Lane = 'main' | 'router';

class LlamaEngine {
  private ctx: LlamaContext | null = null;
  /**
   * A second context on the SAME weights for the router pass. llama.cpp maps
   * the GGUF once (mmap) and Metal wraps those pages without copying, so the
   * extra cost is the small context's KV and compute buffers, not another
   * copy of the model. What it buys: the router's cached prefix and the main
   * prompt's cached prefix never evict each other, so both passes prefill
   * only the user's message.
   */
  private routerCtx: LlamaContext | null = null;
  private routerLoading: Promise<LlamaContext> | null = null;
  private routerBusy = false;
  private state: EngineState = { status: 'unloaded' };
  private listeners = new Set<Listener>();
  private loadPromise: Promise<EngineInfo> | null = null;
  private busy = false;
  private warming: Promise<void> | null = null;
  private nativeLogHooked = false;
  private info: EngineInfo | null = null;

  getState(): EngineState {
    return this.state;
  }

  getInfo(): EngineInfo | null {
    return this.info;
  }

  isReady(): boolean {
    return this.ctx !== null && this.state.status === 'ready';
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  private setState(state: EngineState): void {
    this.state = state;
    for (const l of this.listeners) l(state);
  }

  private hookNativeLog(): void {
    if (this.nativeLogHooked) return;
    this.nativeLogHooked = true;
    void toggleNativeLog(true).catch(() => undefined);
    addNativeLogListener((level, text) => {
      // llama.cpp is chatty at load. Keep what a perf investigation needs:
      // GPU init, context size, KV sizes, and the prefix-cache decisions.
      if (
        /state checkpoint|prompt state cache|cache clear|reusing|n_ctx_seq|KV self size|n_threads|GPU name|GPU family|has unified memory|recommendedMaxWorkingSetSize|failed|error/i.test(
          text,
        ) &&
        !/compile_pipeline/.test(text)
      ) {
        diag(`llama[${level}] ${text.trim().slice(0, 220)}`);
      }
    });
  }

  /** Load a model (replacing whatever is loaded). Safe to call repeatedly. */
  async load(modelId: string, prefs: EnginePrefs): Promise<EngineInfo> {
    if (this.loadPromise) await this.loadPromise.catch(() => undefined);
    if (this.info && this.info.modelId === modelId && this.ctx && this.samePrefs(prefs)) {
      return this.info;
    }
    this.loadPromise = this.doLoad(modelId, prefs);
    try {
      return await this.loadPromise;
    } finally {
      this.loadPromise = null;
    }
  }

  private lastPrefs: EnginePrefs | null = null;
  private samePrefs(p: EnginePrefs): boolean {
    const q = this.lastPrefs;
    return !!q && q.gpu === p.gpu && q.contextTokens === p.contextTokens && q.threads === p.threads && q.kvQuant === p.kvQuant;
  }

  private async doLoad(modelId: string, prefs: EnginePrefs): Promise<EngineInfo> {
    const spec: ModelSpec | undefined = await findModel(modelId);
    if (!spec) throw new Error(`unknown model ${modelId}`);
    this.hookNativeLog();
    await this.unload();
    this.setState({ status: 'loading', modelId, progress: 0 });
    const started = Date.now();
    const threads = prefs.threads > 0 ? prefs.threads : autoThreads();
    const params: ContextParams = {
      model: modelPath(spec),
      n_ctx: prefs.contextTokens,
      // Prefill batch: bigger batches keep the GPU fed during the one-time
      // system-prompt ingest; 512 is llama.cpp's default and well inside the
      // Metal working-set budget for a 2.6B model.
      n_batch: 512,
      n_ubatch: 512,
      n_threads: threads,
      n_gpu_layers: prefs.gpu ? 99 : 0,
      flash_attn_type: prefs.gpu ? 'auto' : 'off',
      ...(prefs.kvQuant && prefs.gpu ? { cache_type_k: 'q8_0' as const, cache_type_v: 'q8_0' as const } : {}),
      use_mmap: true,
      use_mlock: false,
      // The agent loop compacts its own transcript; silent context shifting
      // would corrupt the cached-prefix bookkeeping instead.
      ctx_shift: false,
      // Recurrent/hybrid prefix cache: 200 MiB of snapshots is about eight
      // message boundaries for a 2.6B LFM, plenty for a ten-turn run.
      state_cache_budget_mb: 200,
    };
    try {
      const ctx = await initLlama(params, (progress) => {
        this.setState({ status: 'loading', modelId, progress });
      });
      this.ctx = ctx;
      this.lastPrefs = prefs;
      const info: EngineInfo = {
        modelId,
        desc: ctx.model.desc,
        paramsB: Math.round((ctx.model.nParams / 1e9) * 10) / 10,
        gpu: ctx.gpu,
        reasonNoGPU: ctx.reasonNoGPU,
        isHybrid: ctx.model.is_hybrid || ctx.model.is_recurrent,
        contextTokens: prefs.contextTokens,
        threads,
        loadMs: Date.now() - started,
      };
      this.info = info;
      this.setState({ status: 'ready', info });
      diag(
        `engine loaded ${modelId} in ${info.loadMs}ms gpu=${info.gpu}${info.gpu ? '' : ` (${info.reasonNoGPU})`} ctx=${info.contextTokens} threads=${threads} hybrid=${info.isHybrid} ${info.desc}`,
      );
      return info;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.setState({ status: 'error', modelId, message });
      diag(`engine load FAILED ${modelId}: ${message}`);
      throw err;
    }
  }

  async unload(): Promise<void> {
    if (this.routerCtx) {
      const r = this.routerCtx;
      this.routerCtx = null;
      await r.release().catch(() => undefined);
    }
    if (this.ctx) {
      const ctx = this.ctx;
      this.ctx = null;
      this.info = null;
      await ctx.release().catch(() => undefined);
    }
    this.setState({ status: 'unloaded' });
  }

  private async routerContext(): Promise<LlamaContext> {
    if (this.routerCtx) return this.routerCtx;
    if (this.routerLoading) return this.routerLoading;
    const info = this.info;
    const prefs = this.lastPrefs;
    if (!info || !prefs) throw new Error('no model loaded');
    this.routerLoading = (async () => {
      const spec = await findModel(info.modelId);
      if (!spec) throw new Error(`unknown model ${info.modelId}`);
      const started = Date.now();
      const ctx = await initLlama({
        model: modelPath(spec),
        n_ctx: 1024,
        n_batch: 512,
        n_ubatch: 512,
        n_threads: info.threads,
        n_gpu_layers: prefs.gpu ? 99 : 0,
        flash_attn_type: prefs.gpu ? 'auto' : 'off',
        use_mmap: true,
        use_mlock: false,
        ctx_shift: false,
        state_cache_budget_mb: 48,
      });
      diag(`router lane ready in ${Date.now() - started}ms`);
      this.routerCtx = ctx;
      return ctx;
    })();
    try {
      return await this.routerLoading;
    } finally {
      this.routerLoading = null;
    }
  }

  /** Short constrained completion on the router lane (independent cache). */
  async classify(prompt: string, grammar: string, maxTokens = 12, signal?: AbortSignal): Promise<{ text: string; usage: GenerationUsage }> {
    const ctx = await this.routerContext();
    if (this.routerBusy) throw new Error('the router is already classifying');
    this.routerBusy = true;
    const onAbort = () => void ctx.stopCompletion().catch(() => undefined);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const result = await ctx.completion({
        prompt,
        n_predict: maxTokens,
        temperature: 0,
        stop: ['<|im_end|>', '<|im_start|>'],
        grammar,
        reasoning_format: 'none',
        force_pure_content: true,
      });
      const t = result.timings;
      const totalPrompt = Math.max(t.prompt_n, (t.cache_n ?? 0) - t.predicted_n);
      diag(`router gen: prompt=${totalPrompt} (cached ${Math.max(0, totalPrompt - t.prompt_n)}) in ${Math.round(t.prompt_ms)}ms · out=${t.predicted_n} in ${Math.round(t.predicted_ms)}ms`);
      return {
        text: result.text,
        usage: { promptTokens: totalPrompt, cachedTokens: Math.max(0, totalPrompt - t.prompt_n), completionTokens: t.predicted_n, promptMs: t.prompt_ms, decodeMs: t.predicted_ms },
      };
    } finally {
      signal?.removeEventListener('abort', onAbort);
      this.routerBusy = false;
    }
  }

  /** Prefill the router lane's system prompt so the first message is fast. */
  async warmRouter(prompt: string): Promise<void> {
    try {
      const ctx = await this.routerContext();
      const started = Date.now();
      await ctx.completion({ prompt, n_predict: 1, temperature: 0, stop: [] });
      diag(`router warmed ${prompt.length} chars in ${Date.now() - started}ms`);
    } catch (err) {
      diag(`router warm failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  isBusy(): boolean {
    return this.busy;
  }

  /**
   * One raw-prompt completion. The prompt is passed VERBATIM: the harness
   * owns the chat template (see LocalAdapter), because the model's own jinja
   * template forces thinking open and mangles multi-turn tool history.
   */
  async complete(
    prompt: string,
    options: CompleteOptions,
    onToken: (text: string) => void,
  ): Promise<CompleteResult> {
    // A warm-up may still be prefilling the system prompt; the request waits
    // for it (a second at most) instead of failing.
    if (this.warming) await this.warming.catch(() => undefined);
    const ctx = this.ctx;
    if (!ctx) throw new Error('no model loaded');
    if (this.busy) throw new Error('the model is already generating');
    this.busy = true;
    let cancelled = false;
    const onAbort = () => {
      cancelled = true;
      void ctx.stopCompletion().catch(() => undefined);
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const budget =
        options.thinkingBudgetTokens !== undefined
          ? {
              thinking_budget_tokens: options.thinkingBudgetTokens,
              thinking_start_tag: '<think>',
              thinking_end_tag: '</think>',
              thinking_budget_message: '\nI have thought enough. Deciding now.\n',
              thinking_forced_open: options.thinkingForcedOpen ?? false,
            }
          : {};
      const params: CompletionParams & Record<string, unknown> = {
        prompt,
        n_predict: options.maxTokens,
        temperature: options.temperature,
        top_p: options.topP,
        ...(options.topK !== undefined ? { top_k: options.topK } : {}),
        ...(options.repeatPenalty !== undefined ? { penalty_repeat: options.repeatPenalty, penalty_last_n: 64 } : {}),
        stop: options.stop,
        // Raw text out; the harness parses think blocks and tool calls.
        reasoning_format: 'none',
        force_pure_content: true,
        ...(options.grammar ? { grammar: options.grammar } : {}),
        ...budget,
      };
      const result: NativeCompletionResult = await ctx.completion(params, (data) => {
        if (data.token) onToken(data.token);
      });
      const t = result.timings;
      // llama.rn reports prompt_n = tokens actually prefilled and cache_n =
      // the context position after generation, so the prompt's full length is
      // (position - generated) and the cached part is what was not prefilled.
      const totalPrompt = Math.max(t.prompt_n, (t.cache_n ?? 0) - t.predicted_n);
      const usage: GenerationUsage = {
        promptTokens: totalPrompt,
        cachedTokens: Math.max(0, totalPrompt - t.prompt_n),
        completionTokens: t.predicted_n,
        promptMs: t.prompt_ms,
        decodeMs: t.predicted_ms,
        promptTokensPerSec: t.prompt_per_second,
        decodeTokensPerSec: t.predicted_per_second,
      };
      const stoppedBy: CompleteResult['stoppedBy'] = cancelled || result.interrupted
        ? 'cancelled'
        : result.context_full
          ? 'context_full'
          : result.stopped_eos
            ? 'eos'
            : result.stopped_word
              ? 'stop'
              : 'limit';
      diag(
        `gen END ${stoppedBy}: prompt=${usage.promptTokens} (cached ${usage.cachedTokens}) in ${Math.round(t.prompt_ms)}ms @${t.prompt_per_second.toFixed(0)} tok/s · out=${t.predicted_n} in ${Math.round(t.predicted_ms)}ms @${t.predicted_per_second.toFixed(1)} tok/s`,
      );
      void deviceHealth().then((h) => diag(`health: ${healthLine(h)}`));
      return { text: result.text, usage, stoppedBy };
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
      this.busy = false;
    }
  }

  async stop(): Promise<void> {
    await this.ctx?.stopCompletion().catch(() => undefined);
  }

  /**
   * Prefill a prompt once so its state is cached before the user asks
   * anything. The stable system prompt is ~1250 tokens; on the 2.6B that is
   * 6.6 seconds of prefill measured on an iPhone 15, paid on the first request
   * of every session unless it was paid here, right after load, while the user
   * is still reading the screen.
   */
  async warm(prompt: string): Promise<void> {
    const ctx = this.ctx;
    if (!ctx || this.busy) return;
    this.busy = true;
    const started = Date.now();
    this.warming = (async () => {
      try {
        await ctx.completion({ prompt, n_predict: 1, temperature: 0, stop: [] });
        diag(`engine warmed ${prompt.length} chars in ${Date.now() - started}ms`);
      } catch (err) {
        diag(`engine warm failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        this.busy = false;
        this.warming = null;
      }
    })();
    await this.warming;
  }

  /** llama-bench style numbers: prefill and decode tokens/s on this phone. */
  async bench(): Promise<{ prefillTps: number; decodeTps: number; pp: number; tg: number }> {
    if (this.warming) await this.warming.catch(() => undefined);
    const ctx = this.ctx;
    if (!ctx) throw new Error('no model loaded');
    if (this.busy) throw new Error('the model is already generating');
    this.busy = true;
    try {
      const r = await ctx.bench(256, 64, 1, 2);
      return { prefillTps: r.speedPp, decodeTps: r.speedTg, pp: r.pp, tg: r.tg };
    } finally {
      this.busy = false;
    }
  }

  /** Count the prompt's tokens with the loaded model's tokenizer. */
  async countTokens(text: string): Promise<number> {
    const ctx = this.ctx;
    if (!ctx) return Math.ceil(text.length / 4);
    const r = await ctx.tokenize(text);
    return r.tokens.length;
  }

  async deviceRamBytes(): Promise<number> {
    return DeviceInfo.getTotalMemory();
  }
}

export const engine = new LlamaEngine();

// A JS reload (Fast Refresh, a crash recovery) re-creates this module but not
// the native contexts the previous instance opened. Two resident 2.6B models
// is a jetsam kill waiting to happen, so drop whatever the old JS left behind.
if (__DEV__) void releaseAllLlama().catch(() => undefined);
