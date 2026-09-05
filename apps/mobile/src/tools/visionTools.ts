import type { ToolDefinition } from '@minimus/agent-core';
import { describeImage } from '../services/vision';

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

export function setAttachedImage(path: string | null): void {
  attachedImagePath = path;
}

export function getAttachedImage(): string | null {
  return attachedImagePath;
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
        const description = await describeImage(
          attachedImagePath,
          String(args['question'] ?? 'Describe this image in detail.'),
        );
        return { description: description.slice(0, 1500) };
      },
    },
  ];
}
