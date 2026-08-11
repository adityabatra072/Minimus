/**
 * Hugging Face Hub client — search GGUF-bearing repos and list their .gguf
 * files, for the "add your own model" flow. Same REST endpoints the Swift
 * example's HuggingFaceHubClient uses.
 */

export interface HubModel {
  id: string; // e.g. "unsloth/Qwen3.5-9B-GGUF"
  downloads: number;
  likes: number;
}

export interface HubGgufFile {
  filename: string;
  sizeBytes: number;
  quant: string; // parsed quant label, e.g. "Q4_K_M"
}

export async function searchGgufModels(query: string, signal?: AbortSignal): Promise<HubModel[]> {
  const url =
    `https://huggingface.co/api/models?search=${encodeURIComponent(query)}` +
    `&filter=gguf&sort=downloads&direction=-1&limit=20`;
  const res = await fetch(url, signal ? { signal } : {});
  if (!res.ok) throw new Error(`Hub search failed: HTTP ${res.status}`);
  const rows = (await res.json()) as { id: string; downloads?: number; likes?: number }[];
  return rows.map((r) => ({ id: r.id, downloads: r.downloads ?? 0, likes: r.likes ?? 0 }));
}

const QUANT_RE = /(IQ\d+_[A-Z]+|Q\d+_K_[MSL]|Q\d+_K|Q\d+_\d+|UD-[A-Z0-9_]+|F16|BF16|F32)/i;

export async function listGgufFiles(repoId: string, signal?: AbortSignal): Promise<HubGgufFile[]> {
  const url = `https://huggingface.co/api/models/${repoId}/tree/main?recursive=true`;
  const res = await fetch(url, signal ? { signal } : {});
  if (!res.ok) throw new Error(`Hub listing failed: HTTP ${res.status}`);
  const rows = (await res.json()) as { path: string; size?: number; type: string }[];
  return rows
    .filter((r) => r.type === 'file' && r.path.toLowerCase().endsWith('.gguf'))
    .map((r) => ({
      filename: r.path,
      sizeBytes: r.size ?? 0,
      quant: QUANT_RE.exec(r.path)?.[1]?.toUpperCase() ?? '?',
    }))
    .sort((a, b) => a.sizeBytes - b.sizeBytes);
}

export function downloadUrl(repoId: string, filename: string): string {
  return `https://huggingface.co/${repoId}/resolve/main/${filename}`;
}

export function idFor(repoId: string, filename: string): string {
  const base = filename.split('/').pop()!.replace(/\.gguf$/i, '');
  return `hf-${repoId.split('/')[0]!.toLowerCase()}-${base.toLowerCase()}`.replace(
    /[^a-z0-9.-]+/g,
    '-',
  );
}
