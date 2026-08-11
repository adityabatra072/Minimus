import { RunAnywhere } from '@runanywhere/core';
import { InferenceFramework } from '@runanywhere/proto-ts/model_types';

/**
 * Preloaded model catalog. Curated for agentic tool calling — every entry here
 * was scored on the packages/eval demo suite before inclusion.
 *
 * iPhone 15 / OnePlus 9R tier (≤ ~2.8GB download, ≤ ~3.5GB RAM):
 *  - LFM2.5-2.6B  — primary agent model (ToolSandbox 77.83, BFCLv4 56.88)
 *  - Qwen3.5-4B   — reasoning pick (TAU2 79.9), borderline RAM: gated by device
 *  - LFM2-1.2B-Tool — fast tier, purpose-built for tool calls
 */

export interface CatalogEntry {
  id: string;
  name: string;
  url: string;
  memoryRequirementBytes: number;
  supportsThinking?: boolean;
  /** Free-RAM floor (bytes) below which the model manager hides this entry. */
  minDeviceRamBytes?: number;
}

export const AGENT_MODELS: CatalogEntry[] = [
  {
    id: 'lfm2.5-2.6b-q4_k_m',
    name: 'LiquidAI LFM2.5 2.6B (agent default)',
    url: 'https://huggingface.co/LiquidAI/LFM2.5-2.6B-GGUF/resolve/main/LFM2.5-2.6B-Q4_K_M.gguf',
    memoryRequirementBytes: 1_800_000_000,
    supportsThinking: true,
  },
  {
    id: 'qwen3.5-4b-ud-q4_k_xl',
    name: 'Qwen3.5 4B (deep reasoning)',
    url: 'https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-UD-Q4_K_XL.gguf',
    memoryRequirementBytes: 3_100_000_000,
    supportsThinking: true,
    minDeviceRamBytes: 6_000_000_000,
  },
  {
    id: 'lfm2-1.2b-tool-q4_k_m',
    name: 'LiquidAI LFM2 1.2B Tool (fast)',
    url: 'https://huggingface.co/LiquidAI/LFM2-1.2B-Tool-GGUF/resolve/main/LFM2-1.2B-Tool-Q4_K_M.gguf',
    memoryRequirementBytes: 900_000_000,
  },
  // Big-device tier — shown only when the device has the RAM for it.
  {
    id: 'qwen3.5-9b-q4_k_m',
    name: 'Qwen3.5 9B (big devices)',
    url: 'https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/main/Qwen3.5-9B-Q4_K_M.gguf',
    memoryRequirementBytes: 6_500_000_000,
    supportsThinking: true,
    minDeviceRamBytes: 12_000_000_000,
  },
];

export const DEFAULT_MODEL_ID = 'lfm2.5-2.6b-q4_k_m';

export async function registerCatalog(): Promise<void> {
  for (const entry of AGENT_MODELS) {
    await RunAnywhere.models.register({
      id: entry.id,
      name: entry.name,
      url: entry.url,
      framework: InferenceFramework.INFERENCE_FRAMEWORK_LLAMA_CPP,
      memoryRequirementBytes: entry.memoryRequirementBytes,
      ...(entry.supportsThinking !== undefined
        ? { supportsThinking: entry.supportsThinking }
        : {}),
    });
  }
}
