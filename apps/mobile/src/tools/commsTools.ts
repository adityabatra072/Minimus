import { Linking, NativeModules } from 'react-native';
import type { ToolDefinition } from '@minimus/agent-core';

/**
 * Communication tools — approval-gated (the harness pauses for the user's OK
 * before executing). Each opens the system composer/dialer prefilled; the OS
 * requires the final tap by design, and the approval card + composer make
 * that legible. Schemas match packages/eval/src/mockTools.ts.
 *
 * Names resolve through Contacts: "text Sam" reaches Sam's mobile number, not
 * an SMS addressed to the word Sam. The lookup is deterministic and local.
 */

interface ContactHit {
  name: string;
  nickname: string;
  phones: { label: string; number: string }[];
  emails: string[];
}

interface ContactsNative {
  contactsSearch(query: string): Promise<ContactHit[]>;
}

function native(): ContactsNative | null {
  const mod = (NativeModules as Record<string, ContactsNative | undefined>)['MinimusTools'];
  return mod && typeof mod.contactsSearch === 'function' ? mod : null;
}

const looksLikeNumber = (s: string) => /^[+\d][\d\s().-]{4,}$/.test(s.trim());
const looksLikeEmail = (s: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s.trim());

/** A name becomes the first mobile-ish number of the best contact match. */
export async function resolvePhone(to: string): Promise<{ number: string; name?: string }> {
  if (looksLikeNumber(to)) return { number: to.trim() };
  const mod = native();
  if (!mod) return { number: to };
  const hits = await mod.contactsSearch(to).catch(() => [] as ContactHit[]);
  const hit = hits.find((h) => h.phones.length > 0);
  if (!hit) return { number: to };
  const mobile = hit.phones.find((p) => /mobile|iphone|cell/i.test(p.label)) ?? hit.phones[0]!;
  return { number: mobile.number, name: hit.name };
}

export async function resolveEmail(to: string): Promise<{ email: string; name?: string }> {
  if (looksLikeEmail(to)) return { email: to.trim() };
  const mod = native();
  if (!mod) return { email: to };
  const hits = await mod.contactsSearch(to).catch(() => [] as ContactHit[]);
  const hit = hits.find((h) => h.emails.length > 0);
  return hit ? { email: hit.emails[0]!, name: hit.name } : { email: to };
}

async function open(url: string, failure: string, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  try {
    await Linking.openURL(url);
    return { ok: true, status: 'composer_opened', ...extra };
  } catch {
    throw new Error(failure);
  }
}

export function commsTools(): ToolDefinition[] {
  return [
    {
      name: 'find_contact',
      group: 'comms',
      description: 'Look up a person in the phone contacts by name; returns their phone numbers and emails',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'first name, full name or nickname' } },
        required: ['name'],
      },
      execute: async (args) => {
        const mod = native();
        if (!mod) throw new Error('contacts are not available on this device');
        const hits = await mod.contactsSearch(String(args['name']));
        if (hits.length === 0) return { matches: [], note: 'No contact matched that name.' };
        return {
          matches: hits.map((h) => ({
            name: h.name,
            phones: h.phones.map((p) => `${p.number}${p.label ? ` (${p.label})` : ''}`),
            emails: h.emails,
          })),
        };
      },
    },
    {
      name: 'send_email',
      group: 'comms',
      kind: 'action',
      description: 'Compose an email (opens prefilled; the user confirms the send)',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'recipient email address or contact name' },
          subject: { type: 'string' },
          body: { type: 'string' },
        },
        required: ['to', 'body'],
      },
      needsApproval: true,
      execute: async (args) => {
        const { email, name } = await resolveEmail(String(args['to']));
        const subject = encodeURIComponent(String(args['subject'] ?? ''));
        const body = encodeURIComponent(String(args['body']));
        return open(
          `mailto:${encodeURIComponent(email)}?subject=${subject}&body=${body}`,
          'No email app could handle the compose request.',
          name ? { to: `${name} <${email}>` } : { to: email },
        );
      },
    },
    {
      name: 'send_sms',
      group: 'comms',
      kind: 'action',
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
        const { number, name } = await resolvePhone(String(args['to']));
        const body = encodeURIComponent(String(args['body']));
        // iOS: sms:NUMBER&body=… ; Android: smsto:NUMBER?body=…
        const url = `sms:${encodeURIComponent(number)}&body=${body}`;
        return open(url, 'No messaging app could handle the request.', name ? { to: `${name} (${number})` } : { to: number });
      },
    },
    {
      name: 'make_call',
      group: 'comms',
      kind: 'action',
      description: 'Start a phone call (opens the dialer with the number ready)',
      parameters: {
        type: 'object',
        properties: { to: { type: 'string', description: 'contact name or phone number' } },
        required: ['to'],
      },
      needsApproval: true,
      execute: async (args) => {
        const { number, name } = await resolvePhone(String(args['to']));
        return open(`tel:${encodeURIComponent(number)}`, 'The dialer could not be opened.', name ? { to: `${name} (${number})` } : { to: number });
      },
    },
  ];
}
