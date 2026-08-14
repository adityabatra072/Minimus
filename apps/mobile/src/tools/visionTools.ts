import { RunAnywhere, ImageInputs } from '@runanywhere/core';
import type { ToolDefinition } from '@minimus/agent-core';
import { registerVlmModel, VLM_MODEL_ID } from '../services/catalog';
import { diag } from '../services/diag';

/**
 * Image understanding as a TOOL, not a separate mode: the chat attaches an
 * image, the agent decides to look at it (describe_image), and the
 * description flows back into the same loop — so "what's in this photo and
 * remind me to buy it tomorrow" is one agentic run.
 *
 * The tool is registered under group 'vision' and that group is only exposed
 * while an attachment exists, so it costs zero prompt tokens otherwise.
 */

let attachedImagePath: string | null = null;
let vlmReady = false;

export function setAttachedImage(path: string | null): void {
  attachedImagePath = path;
}

export function getAttachedImage(): string | null {
  return attachedImagePath;
}

async function ensureVlmReady(): Promise<void> {
  if (vlmReady) return;
  await registerVlmModel();
  const downloaded = new Set(
    (await RunAnywhere.models.list({ downloadedOnly: true }).catch(() => [])).map((m) => m.id),
  );
  if (!downloaded.has(VLM_MODEL_ID)) {
    diag('vision: downloading SmolVLM');
    for await (const ev of RunAnywhere.models.download(VLM_MODEL_ID)) {
      if (ev.type === 'failed') throw new Error('vision model download failed');
    }
  }
  await RunAnywhere.models.load(VLM_MODEL_ID);
  vlmReady = true;
}

export function visionTools(): ToolDefinition[] {
  return [
    {
      name: 'describe_image',
      group: 'vision',
      description: 'Look at the image the user attached and answer a question about it',
      parameters: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: 'what to find out, e.g. "describe everything" or "what brand is this?"',
          },
        },
        required: ['question'],
      },
      usageHint: 'The user attached an image — describe_image is how you SEE it.',
      execute: async (args) => {
        if (!attachedImagePath) {
          return { error: 'No image is attached right now.' };
        }
        await ensureVlmReady();
        const result = await RunAnywhere.vlm.generate(
          ImageInputs.file(attachedImagePath),
          String(args['question'] ?? 'Describe this image in detail.'),
        );
        return { description: result.text.slice(0, 1500) };
      },
    },
  ];
}
