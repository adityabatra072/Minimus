import { initLlama, type LlamaContext } from 'llama.rn';
import { VLM_MODEL, downloadModel, isDownloaded, mmprojPath, modelPath } from './models';
import { diag } from './diag';

/**
 * Image understanding on device: SmolVLM-500M through llama.rn's multimodal
 * (mtmd) path. A second, small llama context that is loaded the first time a
 * photo is attached and released after a quiet minute so it never sits on
 * memory the main model needs.
 */

let ctx: LlamaContext | null = null;
let loading: Promise<LlamaContext> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

export async function ensureVisionDownloaded(onProgress?: (fraction: number) => void): Promise<void> {
  if (await isDownloaded(VLM_MODEL)) return;
  diag('vision: downloading SmolVLM');
  await downloadModel(VLM_MODEL, (p) => onProgress?.(p.fraction));
}

async function loadVision(): Promise<LlamaContext> {
  if (ctx) return ctx;
  if (loading) return loading;
  loading = (async () => {
    await ensureVisionDownloaded();
    const started = Date.now();
    const c = await initLlama({
      model: modelPath(VLM_MODEL),
      n_ctx: 2048,
      n_batch: 512,
      n_gpu_layers: 99,
      n_threads: 4,
      use_mmap: true,
      ctx_shift: false,
    });
    const mmproj = mmprojPath(VLM_MODEL);
    if (!mmproj) throw new Error('vision model has no projector');
    await c.initMultimodal({ path: mmproj, use_gpu: true });
    diag(`vision: loaded in ${Date.now() - started}ms gpu=${c.gpu}`);
    ctx = c;
    return c;
  })();
  try {
    return await loading;
  } finally {
    loading = null;
  }
}

function scheduleRelease(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    void releaseVision();
  }, 60_000);
}

export async function releaseVision(): Promise<void> {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  const c = ctx;
  ctx = null;
  if (c) {
    await c.releaseMultimodal().catch(() => undefined);
    await c.release().catch(() => undefined);
    diag('vision: released');
  }
}

export function isVisionLoaded(): boolean {
  return ctx !== null;
}

/** Ask a question about one image. Returns the model's plain-text answer. */
export async function describeImage(imagePath: string, question: string): Promise<string> {
  const c = await loadVision();
  const started = Date.now();
  const result = await c.completion({
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: imagePath.startsWith('file://') ? imagePath : `file://${imagePath}` } },
          { type: 'text', text: question },
        ],
      },
    ],
    jinja: true,
    n_predict: 220,
    temperature: 0.2,
    top_p: 0.9,
  });
  diag(`vision: answered in ${Date.now() - started}ms (${result.timings.predicted_n} tokens)`);
  scheduleRelease();
  return result.content?.trim() || result.text.trim();
}
