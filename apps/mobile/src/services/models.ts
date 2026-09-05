import RNFS from 'react-native-fs';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { diag } from './diag';

/**
 * The model catalog and the downloader, owned by the app.
 *
 * Models are plain GGUF files under Documents/models. Nothing here knows how
 * to run one — services/engine.ts does that — which is what lets the catalog
 * be curated around the one question a phone user has: how fast is it, and
 * what does it give up for that speed.
 */

export type ModelTier = 'fast' | 'balanced' | 'deep';

export interface ModelSpec {
  id: string;
  name: string;
  /** One-line honest pitch shown in the model manager. */
  tagline: string;
  url: string;
  file: string;
  sizeBytes: number;
  params: string;
  /** Deliberates inside <think> before answering. Costs time; buys judgment. */
  thinking: boolean;
  tier: ModelTier;
  /** Hide on devices with less RAM than this. */
  minRamBytes?: number;
  /** Multimodal projector (vision models only). */
  mmproj?: { url: string; file: string; sizeBytes: number };
  kind: 'llm' | 'vlm';
  /** User-added (Hugging Face) rather than curated. */
  custom?: boolean;
}

const HF = 'https://huggingface.co';

export const AGENT_MODELS: ModelSpec[] = [
  {
    id: 'lfm2.5-1.2b-instruct-qad',
    name: 'LFM2.5 1.2B Instruct',
    tagline: 'Fast. Answers in seconds, no thinking pass. Tuned for tool calls.',
    url: `${HF}/LiquidAI/LFM2.5-1.2B-Instruct-GGUF/resolve/main/LFM2.5-1.2B-Instruct-QAD-Q4_0.gguf`,
    file: 'LFM2.5-1.2B-Instruct-QAD-Q4_0.gguf',
    sizeBytes: 731_000_000,
    params: '1.2B',
    thinking: false,
    tier: 'fast',
    kind: 'llm',
  },
  {
    id: 'lfm2.5-2.6b-qad',
    name: 'LFM2.5 2.6B',
    tagline: 'Thinks before it acts. Better judgment on fuzzy asks; slower.',
    url: `${HF}/LiquidAI/LFM2.5-2.6B-GGUF/resolve/main/LFM2.5-2.6B-QAD-Q4_0.gguf`,
    file: 'LFM2.5-2.6B-QAD-Q4_0.gguf',
    sizeBytes: 1_590_000_000,
    params: '2.6B',
    thinking: true,
    tier: 'balanced',
    kind: 'llm',
  },
  {
    id: 'lfm2-1.2b-tool',
    name: 'LFM2 1.2B Tool',
    tagline: 'Purpose-built for function calls. Terse; weak at open questions.',
    url: `${HF}/LiquidAI/LFM2-1.2B-Tool-GGUF/resolve/main/LFM2-1.2B-Tool-Q4_K_M.gguf`,
    file: 'LFM2-1.2B-Tool-Q4_K_M.gguf',
    sizeBytes: 731_000_000,
    params: '1.2B',
    thinking: false,
    tier: 'fast',
    kind: 'llm',
  },
  {
    id: 'qwen3.5-4b',
    name: 'Qwen3.5 4B',
    tagline: 'Deepest reasoning that still fits a 6 GB phone. Slow; heavy.',
    url: `${HF}/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-UD-Q4_K_XL.gguf`,
    file: 'Qwen3.5-4B-UD-Q4_K_XL.gguf',
    sizeBytes: 2_650_000_000,
    params: '4B',
    thinking: false,
    tier: 'deep',
    minRamBytes: 5_500_000_000,
    kind: 'llm',
  },
];

export const VLM_MODEL: ModelSpec = {
  id: 'smolvlm-500m',
  name: 'SmolVLM 500M',
  tagline: 'Looks at photos you attach. Downloads the first time you attach one.',
  url: `${HF}/ggml-org/SmolVLM-500M-Instruct-GGUF/resolve/main/SmolVLM-500M-Instruct-Q8_0.gguf`,
  file: 'SmolVLM-500M-Instruct-Q8_0.gguf',
  sizeBytes: 437_000_000,
  params: '0.5B',
  thinking: false,
  tier: 'fast',
  kind: 'vlm',
  mmproj: {
    url: `${HF}/ggml-org/SmolVLM-500M-Instruct-GGUF/resolve/main/mmproj-SmolVLM-500M-Instruct-Q8_0.gguf`,
    file: 'mmproj-SmolVLM-500M-Instruct-Q8_0.gguf',
    sizeBytes: 109_000_000,
  },
};

export const DEFAULT_MODEL_ID = 'lfm2.5-1.2b-instruct-qad';

export const MODELS_DIR = `${RNFS.DocumentDirectoryPath}/models`;

const CUSTOM_KEY = 'minimus.models.custom.v1';

let customCache: ModelSpec[] | null = null;

export async function loadCustomModels(): Promise<ModelSpec[]> {
  if (customCache) return customCache;
  const raw = await AsyncStorage.getItem(CUSTOM_KEY).catch(() => null);
  try {
    customCache = raw ? (JSON.parse(raw) as ModelSpec[]) : [];
  } catch {
    customCache = [];
  }
  return customCache;
}

export async function addCustomModel(spec: Omit<ModelSpec, 'custom' | 'kind' | 'thinking' | 'tier' | 'params'> & Partial<ModelSpec>): Promise<ModelSpec> {
  const full: ModelSpec = {
    params: '?',
    thinking: false,
    tier: 'balanced',
    kind: 'llm',
    ...spec,
    custom: true,
  };
  const list = (await loadCustomModels()).filter((m) => m.id !== full.id);
  list.push(full);
  customCache = list;
  await AsyncStorage.setItem(CUSTOM_KEY, JSON.stringify(list)).catch(() => undefined);
  return full;
}

export async function removeCustomModel(id: string): Promise<void> {
  const list = (await loadCustomModels()).filter((m) => m.id !== id);
  customCache = list;
  await AsyncStorage.setItem(CUSTOM_KEY, JSON.stringify(list)).catch(() => undefined);
}

export async function allModels(): Promise<ModelSpec[]> {
  return [...AGENT_MODELS, ...(await loadCustomModels())];
}

export async function findModel(id: string): Promise<ModelSpec | undefined> {
  if (id === VLM_MODEL.id) return VLM_MODEL;
  return (await allModels()).find((m) => m.id === id);
}

export function modelPath(spec: ModelSpec): string {
  return `${MODELS_DIR}/${spec.file}`;
}

export function mmprojPath(spec: ModelSpec): string | null {
  return spec.mmproj ? `${MODELS_DIR}/${spec.mmproj.file}` : null;
}

async function ensureDir(): Promise<void> {
  if (!(await RNFS.exists(MODELS_DIR))) await RNFS.mkdir(MODELS_DIR);
}

/** A model counts as present only when every file it needs is complete. */
export async function isDownloaded(spec: ModelSpec): Promise<boolean> {
  const main = await fileComplete(modelPath(spec), spec.sizeBytes);
  if (!main) return false;
  if (spec.mmproj) return fileComplete(`${MODELS_DIR}/${spec.mmproj.file}`, spec.mmproj.sizeBytes);
  return true;
}

async function fileComplete(path: string, expectedBytes: number): Promise<boolean> {
  if (!(await RNFS.exists(path))) return false;
  const stat = await RNFS.stat(path);
  // Catalog sizes are approximate (published rounding); a .part that got
  // renamed early would be far smaller than 90% of the real file.
  return Number(stat.size) >= expectedBytes * 0.9;
}

export async function deleteModel(spec: ModelSpec): Promise<void> {
  for (const p of [modelPath(spec), mmprojPath(spec)]) {
    if (p && (await RNFS.exists(p))) await RNFS.unlink(p);
    if (p && (await RNFS.exists(`${p}.part`))) await RNFS.unlink(`${p}.part`);
  }
}

export async function downloadedBytes(): Promise<number> {
  await ensureDir();
  const entries = await RNFS.readDir(MODELS_DIR);
  return entries.reduce((n, e) => n + Number(e.size), 0);
}

export interface DownloadProgress {
  /** 0..1 across every file the model needs. */
  fraction: number;
  bytesWritten: number;
  totalBytes: number;
  bytesPerSecond: number;
}

const activeJobs = new Map<string, number>();

/**
 * Download every file the model needs, with progress and cancellation.
 * Files land as `.part` and are renamed only when complete, so a killed app
 * never leaves a truncated GGUF that looks downloaded.
 */
export async function downloadModel(
  spec: ModelSpec,
  onProgress: (p: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  await ensureDir();
  const files = [
    { url: spec.url, path: modelPath(spec), size: spec.sizeBytes },
    ...(spec.mmproj ? [{ url: spec.mmproj.url, path: `${MODELS_DIR}/${spec.mmproj.file}`, size: spec.mmproj.sizeBytes }] : []),
  ];
  const totalBytes = files.reduce((n, f) => n + f.size, 0);
  let doneBytes = 0;
  for (const file of files) {
    if (await fileComplete(file.path, file.size)) {
      doneBytes += file.size;
      continue;
    }
    const part = `${file.path}.part`;
    if (await RNFS.exists(part)) await RNFS.unlink(part);
    const startedAt = Date.now();
    let lastReported = 0;
    const { jobId, promise } = RNFS.downloadFile({
      fromUrl: file.url,
      toFile: part,
      background: true,
      discretionary: false,
      progressInterval: 400,
      begin: (res) => diag(`download ${spec.id}: HTTP ${res.statusCode}, ${Math.round(res.contentLength / 1e6)} MB`),
      progress: (res) => {
        const written = res.bytesWritten;
        const elapsed = Math.max(0.5, (Date.now() - startedAt) / 1000);
        if (written - lastReported < 512 * 1024) return;
        lastReported = written;
        onProgress({
          fraction: Math.min(1, (doneBytes + written) / totalBytes),
          bytesWritten: doneBytes + written,
          totalBytes,
          bytesPerSecond: written / elapsed,
        });
      },
    });
    activeJobs.set(spec.id, jobId);
    const onAbort = () => RNFS.stopDownload(jobId);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const result = await promise;
      if (signal?.aborted) throw new Error('download cancelled');
      if (result.statusCode < 200 || result.statusCode >= 300) {
        throw new Error(`download failed: HTTP ${result.statusCode}`);
      }
      await RNFS.moveFile(part, file.path);
      doneBytes += file.size;
    } catch (err) {
      if (await RNFS.exists(part)) await RNFS.unlink(part).catch(() => undefined);
      throw err;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      activeJobs.delete(spec.id);
    }
  }
  onProgress({ fraction: 1, bytesWritten: totalBytes, totalBytes, bytesPerSecond: 0 });
}

export function cancelDownload(id: string): void {
  const job = activeJobs.get(id);
  if (job !== undefined) RNFS.stopDownload(job);
}

/**
 * Adopt GGUFs an earlier build downloaded through the previous SDK, which kept
 * them under its own directory tree. A user who already paid for 1.7 GB of
 * download should not pay again because the engine changed underneath them.
 */
export async function adoptLegacyModels(): Promise<string[]> {
  await ensureDir();
  const adopted: string[] = [];
  const wanted = new Map<string, ModelSpec>();
  for (const m of [...AGENT_MODELS, VLM_MODEL]) wanted.set(m.file.toLowerCase(), m);
  // The old catalog shipped LFM2.5-2.6B-Q4_K_M; it is the same family and a
  // fine stand-in for the QAD build until the user chooses to re-download.
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 4) return;
    const entries = await RNFS.readDir(dir).catch(() => []);
    for (const e of entries) {
      if (e.path.startsWith(MODELS_DIR)) continue;
      if (e.isDirectory()) {
        await walk(e.path, depth + 1);
      } else if (e.name.toLowerCase().endsWith('.gguf')) {
        const spec = wanted.get(e.name.toLowerCase());
        if (spec && !(await RNFS.exists(modelPath(spec)))) {
          await RNFS.moveFile(e.path, modelPath(spec)).catch(() => undefined);
          adopted.push(spec.id);
        }
      }
    }
  };
  await walk(RNFS.DocumentDirectoryPath, 0);
  if (adopted.length) diag(`adopted legacy models: ${adopted.join(', ')}`);
  return adopted;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(bytes >= 10e9 ? 0 : 1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.round(bytes / 1e3)} KB`;
}
