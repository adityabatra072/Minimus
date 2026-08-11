import { ToolRegistry, type ToolCall } from '@minimus/agent-core';

/**
 * Mock implementations of the demo tool set. Definitions (names, schemas,
 * groups, approval flags) MUST stay in lockstep with the real device tools in
 * apps/mobile — the eval measures whether models can drive these exact
 * schemas, so schema drift here invalidates the scorecard.
 */

export interface RecordedCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface MockToolSetup {
  registry: ToolRegistry;
  recorded: RecordedCall[];
}

const CANNED: Record<string, unknown> = {
  flashlight: { ok: true },
  set_brightness: { ok: true },
  open_app: { ok: true, opened: true },
  device_info: { battery_percent: 78, network: 'wifi', storage_free_gb: 42.5 },
  fetch_page: { text: 'Night Mode is the latest single by Drake, released August 8, 2026.' },
  calendar_create: { ok: true, event_id: 'evt_123' },
  calendar_query: { events: [{ title: 'Standup', start: '2026-08-12T09:30:00', id: 'evt_9' }] },
  create_reminder: { ok: true, reminder_id: 'rem_1' },
  set_alarm: { ok: true, alarm_id: 'alm_1' },
  set_timer: { ok: true, timer_id: 'tmr_1' },
  schedule_task: { ok: true, task_id: 'tsk_1' },
  play_music: { ok: true, now_playing: true },
  send_email: { ok: true, status: 'composer_opened' },
  send_sms: { ok: true, status: 'composer_opened' },
  make_call: { ok: true, status: 'dialing' },
  clipboard_write: { ok: true },
  send_notification: { ok: true },
  run_js: { output: '42' },
};

/** Query-aware mock search — returning Drake results for every query teaches
 * the model that search is broken and sends small models into retry spirals. */
function webSearchFor(query: string): Record<string, unknown> {
  const q = query.toLowerCase();
  if (q.includes('drake')) {
    return {
      results: [
        {
          title: 'Drake announces new single "Night Mode" (2026)',
          url: 'https://example.com/drake-night-mode',
          snippet: 'Drake released his latest song Night Mode on August 8, 2026…',
        },
        {
          title: 'Drake — discography',
          url: 'https://example.com/drake-discography',
          snippet: 'Full list of Drake releases through 2026.',
        },
      ],
    };
  }
  if (q.includes('france') || q.includes('paris')) {
    return {
      results: [
        {
          title: 'Paris - Wikipedia',
          url: 'https://en.wikipedia.org/wiki/Paris',
          snippet: 'Paris is the capital and largest city of France.',
        },
      ],
    };
  }
  return {
    results: [
      {
        title: `Results for "${query}"`,
        url: 'https://example.com/generic',
        snippet: `General information about ${query}.`,
      },
    ],
  };
}

export function buildMockTools(overrides: Record<string, unknown> = {}): MockToolSetup {
  const registry = new ToolRegistry();
  const recorded: RecordedCall[] = [];

  const record =
    (name: string) =>
    async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
      recorded.push({ name, arguments: args });
      const override = overrides[name];
      if (override !== undefined) {
        return typeof override === 'object' && override !== null
          ? (override as Record<string, unknown>)
          : { result: override };
      }
      if (name === 'web_search') return webSearchFor(String(args['query'] ?? ''));
      const result = CANNED[name] ?? { ok: true };
      return typeof result === 'object' && result !== null
        ? (result as Record<string, unknown>)
        : { result };
    };

  // ---- device group ----
  registry.register({
    name: 'flashlight',
    group: 'device',
    description: 'Turn the phone flashlight (torch) on or off',
    parameters: {
      type: 'object',
      properties: { on: { type: 'boolean', description: 'true to turn on, false to turn off' } },
      required: ['on'],
    },
    execute: record('flashlight'),
  });
  registry.register({
    name: 'set_brightness',
    group: 'device',
    description: 'Set screen brightness',
    parameters: {
      type: 'object',
      properties: { level: { type: 'number', description: '0.0 (dim) to 1.0 (max)' } },
      required: ['level'],
    },
    execute: record('set_brightness'),
  });
  registry.register({
    name: 'device_info',
    group: 'device',
    description: 'Get battery level, network status and free storage',
    parameters: { type: 'object', properties: {} },
    execute: record('device_info'),
  });
  registry.register({
    name: 'open_app',
    group: 'device',
    description: 'Open another app on the phone by name',
    parameters: {
      type: 'object',
      properties: { app: { type: 'string', description: 'app name, e.g. "spotify", "settings", "camera"' } },
      required: ['app'],
    },
    execute: record('open_app'),
  });
  registry.register({
    name: 'clipboard_write',
    group: 'device',
    description: 'Copy text to the clipboard',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    execute: record('clipboard_write'),
  });

  // ---- web group ----
  registry.register({
    name: 'web_search',
    group: 'web',
    description: 'Search the web and get result titles, URLs and snippets',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'search query' } },
      required: ['query'],
    },
    execute: record('web_search'),
  });
  registry.register({
    name: 'fetch_page',
    group: 'web',
    description: 'Fetch a web page and return its readable text',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
    execute: record('fetch_page'),
  });

  // ---- schedule group ----
  registry.register({
    name: 'calendar_create',
    group: 'schedule',
    description: 'Create a calendar event',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        start: { type: 'string', description: 'ISO 8601 datetime, e.g. 2026-08-12T15:00:00' },
        duration_minutes: { type: 'number' },
        notes: { type: 'string' },
      },
      required: ['title', 'start'],
    },
    execute: record('calendar_create'),
  });
  registry.register({
    name: 'calendar_query',
    group: 'schedule',
    description: 'List calendar events in a date range',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'ISO date' },
        to: { type: 'string', description: 'ISO date' },
      },
      required: ['from'],
    },
    execute: record('calendar_query'),
  });
  registry.register({
    name: 'create_reminder',
    group: 'schedule',
    description:
      'Create a simple reminder that shows a fixed message at a time. It cannot check anything or perform actions — for "do/check X later" use schedule_task instead.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        when: { type: 'string', description: 'ISO 8601 datetime for the reminder' },
      },
      required: ['title', 'when'],
    },
    execute: record('create_reminder'),
  });
  registry.register({
    name: 'set_alarm',
    group: 'schedule',
    description: 'Set an alarm clock at a time of day',
    parameters: {
      type: 'object',
      properties: {
        time: { type: 'string', description: '24h HH:MM, e.g. 07:30' },
        label: { type: 'string' },
      },
      required: ['time'],
    },
    execute: record('set_alarm'),
  });
  registry.register({
    name: 'set_timer',
    group: 'schedule',
    description: 'Start a countdown timer',
    parameters: {
      type: 'object',
      properties: {
        minutes: { type: 'number', description: 'countdown length in minutes' },
        label: { type: 'string' },
      },
      required: ['minutes'],
    },
    execute: record('set_timer'),
  });
  registry.register({
    name: 'schedule_task',
    group: 'schedule',
    description:
      'Schedule the assistant itself to act later: at the given time it wakes up with ALL tools (battery, web, notifications, music, …) and performs the instruction.',
    usageHint:
      'schedule_task is ONLY for deferred assistant actions ("in 30 min check my battery", "at 6pm search X"). Wake-up alarms → set_alarm. Countdown timers → set_timer. Fixed-message reminders → create_reminder.',
    parameters: {
      type: 'object',
      properties: {
        instruction: { type: 'string', description: 'what to do when the time comes' },
        when: { type: 'string', description: 'ISO 8601 datetime or +N minutes, e.g. "+30"' },
      },
      required: ['instruction', 'when'],
    },
    execute: record('schedule_task'),
  });

  // ---- music group ----
  registry.register({
    name: 'play_music',
    group: 'music',
    description: 'Play a song, artist or playlist on Spotify',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'song/artist/playlist to play, e.g. "Night Mode by Drake"' },
      },
      required: ['query'],
    },
    execute: record('play_music'),
  });

  // ---- comms group (approval-gated like the real tools) ----
  registry.register({
    name: 'send_email',
    group: 'comms',
    description: 'Compose and send an email',
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
    execute: record('send_email'),
  });
  registry.register({
    name: 'send_sms',
    group: 'comms',
    description: 'Send a text message',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'contact name or phone number' },
        body: { type: 'string' },
      },
      required: ['to', 'body'],
    },
    needsApproval: true,
    execute: record('send_sms'),
  });
  registry.register({
    name: 'make_call',
    group: 'comms',
    description: 'Start a phone call',
    parameters: {
      type: 'object',
      properties: { to: { type: 'string', description: 'contact name or phone number' } },
      required: ['to'],
    },
    needsApproval: true,
    execute: record('make_call'),
  });
  registry.register({
    name: 'send_notification',
    group: 'schedule',
    description: 'Show a local notification now or at a time',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        body: { type: 'string' },
        when: { type: 'string', description: 'optional ISO time; omit for now' },
      },
      required: ['title'],
    },
    execute: record('send_notification'),
  });

  // ---- code group ----
  registry.register({
    name: 'run_js',
    group: 'code',
    description: 'Run a short JavaScript snippet in a sandbox and return what it prints',
    parameters: {
      type: 'object',
      properties: { code: { type: 'string', description: 'JavaScript source; use console.log for output' } },
      required: ['code'],
    },
    execute: record('run_js'),
  });

  return { registry, recorded };
}

export function matchesExpectedArgs(
  actual: Record<string, unknown>,
  expected?: Record<string, unknown>,
): boolean {
  if (!expected) return true;
  for (const [key, want] of Object.entries(expected)) {
    const got = actual[key];
    if (want !== null && typeof want === 'object' && !Array.isArray(want) && 're' in (want as object)) {
      const re = new RegExp(String((want as { re: unknown }).re), 'i');
      if (!re.test(String(got ?? ''))) return false;
    } else if (Array.isArray(want)) {
      if (JSON.stringify(want) !== JSON.stringify(got)) return false;
    } else if (got !== want) {
      return false;
    }
  }
  return true;
}

/** Expected calls must appear as an ordered subsequence of recorded calls. */
export function callsSatisfy(
  recorded: RecordedCall[] | ToolCall[],
  expected: { tool: string; args?: Record<string, unknown> }[],
): boolean {
  let idx = 0;
  for (const rec of recorded) {
    const want = expected[idx];
    if (!want) break;
    const name = 'name' in rec ? rec.name : '';
    if (name === want.tool && matchesExpectedArgs(rec.arguments, want.args)) idx++;
  }
  return idx === expected.length;
}
