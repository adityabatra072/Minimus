import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DEFAULT_MODEL_ID } from '../services/models';
import { DEFAULT_ENGINE_PREFS, engine, type EnginePrefs, type EngineState } from '../services/engine';
import { diag } from '../services/diag';
import { AgentLoop, ALL_TOOL_GROUPS, composeRun, policyFor, renderChatMl, routerMessages } from '@minimus/agent-core';
import { getToolRegistry } from '../tools';
import { userToolGroups, userExcludedTools } from '../services/toolPlatform';

/**
 * Which model is the brain, how the engine runs it, and whether it is loaded.
 * Persisted; the engine itself is a singleton in services/engine.ts and this
 * store mirrors its state for the UI.
 */

interface ModelState {
  activeModelId: string;
  prefs: EnginePrefs;
  engineState: EngineState;
  /** Last measured speed on this phone, for the model manager. */
  lastBench: { modelId: string; prefillTps: number; decodeTps: number; atMs: number } | null;
  setActiveModel: (id: string) => void;
  setPrefs: (patch: Partial<EnginePrefs>) => void;
  setLastBench: (b: ModelState['lastBench']) => void;
  hydrate: () => Promise<void>;
  /** Load the active model with the current prefs (idempotent). */
  ensureLoaded: () => Promise<void>;
}

const KEY = 'minimus.activeModelId';
const PREFS_KEY = 'minimus.enginePrefs.v1';
const BENCH_KEY = 'minimus.lastBench.v1';

// Model ids from the previous engine's catalog map onto the new files.
const LEGACY_IDS: Record<string, string> = {
  'lfm2.5-2.6b-q4_k_m': 'lfm2.5-2.6b-qad',
  'qwen3.5-4b-ud-q4_k_xl': 'qwen3.5-4b',
  'lfm2-1.2b-tool-q4_k_m': 'lfm2-1.2b-tool',
};

/**
 * Render the exact system prompt a plain request produces (full tool set,
 * default composition) and run it through the engine once, so the checkpoint
 * at the end of the system turn exists before the first real request.
 */
async function warmSystemPrompt(modelId: string): Promise<void> {
  try {
    const policy = policyFor(modelId);
    const composition = composeRun('hello', {
      extraToolGroups: userToolGroups(),
      extraExcludeTools: userExcludedTools(),
    });
    const excluded = new Set(composition.excludeTools);
    const tools = getToolRegistry()
      .list(composition.toolGroups.length ? composition.toolGroups : ALL_TOOL_GROUPS)
      .filter((t) => !excluded.has(t.name));
    // THE system prompt: the router pass and every main pass of the session
    // share it byte for byte (AgentLoop.systemPromptFor), so warming it once
    // pays the ~1500-token prefill before the user types anything.
    const system = AgentLoop.systemPromptFor(tools, policy, composition.preamble);
    const lfm = modelId.toLowerCase().includes('lfm');
    // The engine snapshots state at the FIRST CONTENT TOKEN after a run of
    // template delimiters, so the warm prompt carries one token of user
    // content after `<|im_start|>user\n`. A real message diverges exactly at
    // that token and the snapshot before it is what gets restored.
    const prompt = renderChatMl([{ role: 'system', content: system }], { lfm, thinking: 'none' }).replace(/<\|im_start\|>assistant\n$/, '<|im_start|>user\nx');
    await engine.warm(prompt);
    const routerPrompt = renderChatMl(routerMessages('x'), { lfm, thinking: 'closed' });
    await engine.warmRouter(routerPrompt);
  } catch (err) {
    diag(`warm skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const useModelStore = create<ModelState>((set, get) => ({
  activeModelId: DEFAULT_MODEL_ID,
  prefs: DEFAULT_ENGINE_PREFS,
  engineState: { status: 'unloaded' },
  lastBench: null,

  setActiveModel: (id: string) => {
    set({ activeModelId: id });
    AsyncStorage.setItem(KEY, id).catch(() => undefined);
  },

  setPrefs: (patch) => {
    const prefs = { ...get().prefs, ...patch };
    set({ prefs });
    AsyncStorage.setItem(PREFS_KEY, JSON.stringify(prefs)).catch(() => undefined);
  },

  setLastBench: (lastBench) => {
    set({ lastBench });
    AsyncStorage.setItem(BENCH_KEY, JSON.stringify(lastBench)).catch(() => undefined);
  },

  hydrate: async () => {
    const [saved, prefsRaw, benchRaw] = await Promise.all([
      AsyncStorage.getItem(KEY).catch(() => null),
      AsyncStorage.getItem(PREFS_KEY).catch(() => null),
      AsyncStorage.getItem(BENCH_KEY).catch(() => null),
    ]);
    if (saved) set({ activeModelId: LEGACY_IDS[saved] ?? saved });
    if (prefsRaw) {
      try {
        set({ prefs: { ...DEFAULT_ENGINE_PREFS, ...(JSON.parse(prefsRaw) as Partial<EnginePrefs>) } });
      } catch {
        /* keep defaults */
      }
    }
    if (benchRaw) {
      try {
        set({ lastBench: JSON.parse(benchRaw) as ModelState['lastBench'] });
      } catch {
        /* ignore */
      }
    }
    engine.subscribe((engineState) => set({ engineState }));
  },

  ensureLoaded: async () => {
    const { activeModelId, prefs } = get();
    try {
      const before = engine.getInfo()?.modelId;
      await engine.load(activeModelId, prefs);
      if (before !== activeModelId) void warmSystemPrompt(activeModelId);
    } catch (err) {
      diag(`ensureLoaded failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  },
}));
