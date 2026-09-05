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
  set_alarm: { ok: true, alarm_id: 'alm_1' },
  set_timer: { ok: true, timer_id: 'tmr_1' },
  list_alarms: { alarms: [{ time: '6:45 AM', enabled: true, repeats: 'once' }], timers: [{ label: 'pasta', remaining: '4:12', state: 'running' }] },
  cancel_alarm: { ok: true, removed: ['6:45 AM'], remaining_alarms: 0 },
  change_alarm: { ok: true, was: '6:45 AM', now: '7:00 AM', repeats: 'once', enabled: true },
  timer_control: { ok: true, action: 'add_minutes', timers: ['pasta: now 9:12 left'] },
  daily_brief: {
    now: 'Monday 8:02 AM',
    calendar_today: [{ title: 'Standup', at: '09:30', ends: '09:45' }],
    reminders_due: [{ title: 'Call dentist' }],
    alarms: [],
    timers: [],
    scheduled_tasks: [],
  },
  schedule_task: { ok: true, task_id: 'tsk_1' },
  play_music: { ok: true, now_playing: true },
  send_email: { ok: true, status: 'composer_opened' },
  send_sms: { ok: true, status: 'composer_opened' },
  make_call: { ok: true, status: 'dialing' },
  clipboard_write: { ok: true },
  send_notification: { ok: true },
  find_contact: {
    matches: [
      { name: 'Sam Rivera', phones: ['+1 555 0100 (mobile)'], emails: ['sam@example.com'] },
    ],
  },
  open_url: { ok: true, opened: 'https://example.com' },
  clipboard_read: { text: 'Trattoria da Enzo, via dei Vascellari 29', empty: false },
  create_reminder: { ok: true, reminder: 'charge phone', due: '21:00' },
  run_js: { output: '42' },
  remember: { ok: true, remembered: true },
  forget: { ok: true, forgot: ['locker code is 4417'], remaining: 2 },
  recall: {
    matches: [
      { fact: 'Sarah recommended Trattoria da Enzo in Rome', saved: '2026-08-12' },
      { fact: 'Battery was 74% at 18:40', saved: '2026-08-12' },
    ],
  },
  define_macro: { ok: true, learned: true, step_count: 3 },
  run_macro: { ok: true, performed: [{ tool: 'set_brightness', ok: true }] },
  calendar_query: {
    date: '2026-08-13',
    events: [
      { title: 'Standup', from: '09:30', to: '10:00' },
      { title: 'Design review', from: '11:00', to: '12:00' },
      { title: '1:1 with Sanchit', from: '15:00', to: '15:30' },
    ],
    free_gaps: [
      { from: '08:00', to: '09:30', minutes: 90 },
      { from: '10:00', to: '11:00', minutes: 60 },
      { from: '12:00', to: '15:00', minutes: 180 },
      { from: '15:30', to: '22:00', minutes: 390 },
    ],
  },
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
    kind: 'action',
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
    kind: 'action',
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
    kind: 'action',
    group: 'device',
    description: 'Open another app on the phone by name',
    parameters: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'app name, e.g. "spotify", "settings", "camera"' },
      },
      required: ['app'],
    },
    execute: record('open_app'),
  });
  registry.register({
    name: 'clipboard_write',
    kind: 'action',
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
    kind: 'action',
    group: 'schedule',
    description: 'Book an event or block time on the calendar',
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
    description:
      'Look at the calendar for a day: returns the events and the free gaps between them',
    parameters: {
      type: 'object',
      properties: {
        date: {
          type: 'string',
          description: '"today", "tomorrow", or an ISO date like 2026-08-13',
        },
      },
      required: ['date'],
    },
    execute: record('calendar_query'),
  });
  registry.register({
    name: 'set_alarm',
    kind: 'action',
    group: 'schedule',
    description:
      'Set a NEW alarm that rings at a time of day (a real alarm, like the Clock app). It only rings — it cannot check or do anything. To move or remove an existing alarm use change_alarm / cancel_alarm.',
    parameters: {
      type: 'object',
      properties: {
        time: { type: 'string', description: '24h HH:MM, e.g. 07:30' },
        label: { type: 'string' },
        repeat: {
          type: 'string',
          enum: ['once', 'daily'],
          description: 'daily when the user says every day / weekdays / each morning',
        },
      },
      required: ['time'],
    },
    execute: record('set_alarm'),
  });
  registry.register({
    name: 'set_timer',
    kind: 'action',
    group: 'schedule',
    description:
      'Start a countdown timer that rings when it finishes. It only rings — it cannot check or do anything.',
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
    kind: 'action',
    group: 'schedule',
    description:
      'Schedule the assistant itself to act later: at the given time it wakes up with ALL tools (battery, web, notifications, music, …) and performs the instruction.',
    usageHint:
      'ANY request of the form "in N minutes / later / at TIME, check X" or "tell me if Y" → schedule_task. set_timer and set_alarm only ring a bell; they cannot check, compare or decide. Putting an event or time block ON THE CALENDAR is calendar_create, never schedule_task.',
    parameters: {
      type: 'object',
      properties: {
        instruction: { type: 'string', description: 'what to do when the time comes' },
        when: { type: 'string', description: 'ISO 8601 datetime or +N minutes, e.g. "+30"' },
        repeat: {
          type: 'string',
          enum: ['once', 'daily'],
          description: 'daily when the user wants this every day at that time',
        },
      },
      required: ['instruction', 'when'],
    },
    execute: record('schedule_task'),
  });

  // ---- music group ----
  registry.register({
    name: 'play_music',
    kind: 'action',
    group: 'music',
    description: 'Play a song, artist or playlist on Spotify',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'song/artist/playlist to play, e.g. "Night Mode by Drake"',
        },
      },
      required: ['query'],
    },
    execute: record('play_music'),
  });

  // ---- comms group (approval-gated like the real tools) ----
  registry.register({
    name: 'find_contact',
    group: 'comms',
    description:
      'Look up a person in the phone contacts by name; returns their phone numbers and emails',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'first name, full name or nickname' } },
      required: ['name'],
    },
    execute: record('find_contact'),
  });
  registry.register({
    name: 'open_url',
    group: 'device',
    kind: 'action',
    description: 'Open a web address in the browser, or a maps search like "maps:coffee near me"',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'https://… link, or "maps:<place or query>" to open Maps',
        },
      },
      required: ['url'],
    },
    execute: record('open_url'),
  });
  registry.register({
    name: 'clipboard_read',
    group: 'device',
    description: 'Read the text currently on the clipboard',
    parameters: { type: 'object', properties: {} },
    execute: record('clipboard_read'),
  });
  registry.register({
    name: 'create_reminder',
    group: 'schedule',
    kind: 'action',
    description:
      'Add an item to the Reminders app, optionally due at a time (a to-do the user can tick off)',
    usageHint:
      'A to-do the PERSON ticks off later. It cannot check anything, compare values or notify on a condition — "check X and tell me if Y" is schedule_task, never create_reminder.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        when: {
          type: 'string',
          description:
            'optional: "+N" minutes from now, "HH:MM", "tomorrow HH:MM", or an ISO datetime',
        },
        notes: { type: 'string' },
      },
      required: ['title'],
    },
    execute: record('create_reminder'),
  });
  registry.register({
    name: 'send_email',
    kind: 'action',
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
    kind: 'action',
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
    kind: 'action',
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
    name: 'list_alarms',
    kind: 'query',
    group: 'schedule',
    description: 'Every alarm and running timer on the phone: times, labels, on/off, time left.',
    parameters: { type: 'object', properties: {} },
    execute: record('list_alarms'),
  });
  registry.register({
    name: 'cancel_alarm',
    kind: 'action',
    group: 'schedule',
    description: 'Remove an alarm (by its time, its label, or all of them). Use for "cancel / delete / turn off my alarm".',
    parameters: {
      type: 'object',
      properties: {
        time: { type: 'string', description: 'the alarm time, e.g. 06:45 or 7 pm' },
        label: { type: 'string', description: 'the alarm label, if the user named it' },
        all: { type: 'boolean', description: 'true to remove every alarm' },
        disable_only: { type: 'boolean', description: 'true to switch it off but keep it in the list' },
      },
    },
    execute: record('cancel_alarm'),
  });
  registry.register({
    name: 'change_alarm',
    kind: 'action',
    group: 'schedule',
    description: 'Move an existing alarm to a new time, rename it, make it daily or one-off, or switch it back on. Identify it by its current time or label.',
    parameters: {
      type: 'object',
      properties: {
        time: { type: 'string', description: 'current time of the alarm to change, e.g. 06:45 (omit when only one alarm exists)' },
        label: { type: 'string', description: 'current label, if the user named it' },
        new_time: { type: 'string', description: 'new time, 24h HH:MM' },
        new_label: { type: 'string' },
        repeat: { type: 'string', enum: ['once', 'daily'] },
        enabled: { type: 'boolean', description: 'true to switch on, false to switch off' },
      },
    },
    execute: record('change_alarm'),
  });
  registry.register({
    name: 'timer_control',
    kind: 'action',
    group: 'schedule',
    description: 'Pause, resume, cancel, or add/remove minutes on a running timer. With one timer running no label is needed.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['pause', 'resume', 'cancel', 'add_minutes'] },
        minutes: { type: 'number', description: 'for add_minutes: minutes to add (negative to take away)' },
        label: { type: 'string', description: 'which timer, when several are running' },
        all: { type: 'boolean', description: 'apply to every timer' },
      },
      required: ['action'],
    },
    execute: record('timer_control'),
  });
  registry.register({
    name: 'send_notification',
    kind: 'action',
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
      properties: {
        code: { type: 'string', description: 'JavaScript source; use console.log for output' },
      },
      required: ['code'],
    },
    execute: record('run_js'),
  });

  // ---- memory (on-device personal context) ----
  registry.register({
    name: 'remember',
    kind: 'action',
    group: 'memory',
    description:
      'Save a fact to on-device memory so it can be recalled later (stays on this phone)',
    usageHint:
      'remember stores INFORMATION to answer questions later. If the user is instead describing a phrase that should PERFORM actions ("when I say X, do Y and Z", "new rule: …"), that is define_macro, not remember.',
    parameters: {
      type: 'object',
      properties: {
        fact: { type: 'string', description: 'the fact to remember, phrased plainly' },
      },
      required: ['fact'],
    },
    execute: record('remember'),
  });
  registry.register({
    name: 'forget',
    kind: 'action',
    group: 'memory',
    description:
      'Delete a saved fact from on-device memory (the opposite of remember). Matching is fuzzy: describe the fact and the closest saved ones are removed.',
    usageHint:
      'Use forget when the user says forget / delete / remove / erase something they told you earlier ("forget my locker code", "delete what I said about Sarah"). Pass a short description of the fact, not the whole sentence. If the user wants to forget a taught PHRASE, that is delete_macro, not forget.',
    parameters: {
      type: 'object',
      properties: {
        about: {
          type: 'string',
          description: 'what the fact is about, e.g. "locker code" or "Sarah restaurant"',
        },
        all: {
          type: 'boolean',
          description: 'true only when the user explicitly asks to wipe every memory',
        },
      },
      required: ['about'],
    },
    execute: record('forget'),
  });
  registry.register({
    name: 'recall',
    group: 'memory',
    description: 'Search on-device memory for previously saved facts',
    usageHint:
      'recall is for finding saved information. If the user says a phrase they TAUGHT you, that is run_macro, not recall.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'what to look for' } },
      required: ['query'],
    },
    execute: record('recall'),
  });

  // ---- taught verbs ----
  registry.register({
    name: 'define_macro',
    kind: 'action',
    group: 'macro',
    description:
      'Record a phrase the user is teaching you, together with the actions it should perform later. Recording only — the actions do NOT happen now.',
    usageHint:
      'When the user says "when I say X, …" or "new rule: …" they are TEACHING you a phrase, not asking you to act now. Do NOT perform the actions. Call define_macro once with name="X" and every step in the list.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'the phrase the user will say, e.g. "wind down"' },
        steps: {
          type: 'array',
          description: 'ordered tool calls, each {"tool": "<tool name>", "arguments": {…}}',
          items: { type: 'object' },
        },
      },
      required: ['name', 'steps'],
    },
    execute: record('define_macro'),
  });
  registry.register({
    name: 'delete_macro',
    kind: 'action',
    group: 'macro',
    description:
      'Forget a taught phrase so saying it no longer does anything (the opposite of define_macro).',
    usageHint:
      'Use when the user asks to forget, delete or remove a PHRASE they taught ("forget the wind down rule"). Forgetting a saved FACT is forget, not delete_macro.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'the phrase, as taught, e.g. "wind down"' },
      },
      required: ['name'],
    },
    execute: record('delete_macro'),
  });
  registry.register({
    name: 'run_macro',
    kind: 'action',
    group: 'macro',
    description: 'Run a phrase the user taught earlier (performs all of its actions)',
    usageHint:
      'If the user says a short phrase they previously taught you, call run_macro with that phrase — do not perform the actions individually.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'the taught phrase' } },
      required: ['name'],
    },
    execute: record('run_macro'),
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
    if (
      want !== null &&
      typeof want === 'object' &&
      !Array.isArray(want) &&
      'min_items' in (want as object)
    ) {
      const min = Number((want as { min_items: unknown }).min_items);
      if (!Array.isArray(got) || got.length < min) return false;
    } else if (
      want !== null &&
      typeof want === 'object' &&
      !Array.isArray(want) &&
      're' in (want as object)
    ) {
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
