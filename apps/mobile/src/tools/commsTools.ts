import { Linking } from 'react-native';
import type { ToolDefinition } from '@minimus/agent-core';

/**
 * Communication tools — approval-gated (the harness pauses for the user's OK
 * before executing). Each opens the system composer/dialer prefilled; the OS
 * requires the final tap by design, and the approval card + composer make
 * that legible in the demo. Schemas match packages/eval/src/mockTools.ts.
 */

async function open(url: string, failure: string): Promise<Record<string, unknown>> {
  try {
    await Linking.openURL(url);
    return { ok: true, status: 'composer_opened' };
  } catch {
    throw new Error(failure);
  }
}

export function commsTools(): ToolDefinition[] {
  return [
    {
      name: 'send_email',
      group: 'comms',
      description: 'Compose an email (opens prefilled; the user confirms the send)',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'recipient email address' },
          subject: { type: 'string' },
          body: { type: 'string' },
        },
        required: ['to', 'body'],
      },
      needsApproval: true,
      execute: async (args) => {
        const to = encodeURIComponent(String(args['to']));
        const subject = encodeURIComponent(String(args['subject'] ?? ''));
        const body = encodeURIComponent(String(args['body']));
        return open(
          `mailto:${to}?subject=${subject}&body=${body}`,
          'No email app could handle the compose request.',
        );
      },
    },
    {
      name: 'send_sms',
      group: 'comms',
      description: 'Compose a text message (opens prefilled; the user confirms the send)',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'contact name or phone number' },
          body: { type: 'string' },
        },
        required: ['to', 'body'],
      },
      needsApproval: true,
      execute: async (args) => {
        const to = encodeURIComponent(String(args['to']));
        const body = encodeURIComponent(String(args['body']));
        return open(`smsto:${to}?body=${body}`, 'No messaging app could handle the request.');
      },
    },
    {
      name: 'make_call',
      group: 'comms',
      description: 'Start a phone call (opens the dialer with the number ready)',
      parameters: {
        type: 'object',
        properties: { to: { type: 'string', description: 'phone number to call' } },
        required: ['to'],
      },
      needsApproval: true,
      execute: async (args) => {
        const to = encodeURIComponent(String(args['to']));
        return open(`tel:${to}`, 'The dialer could not be opened.');
      },
    },
  ];
}
