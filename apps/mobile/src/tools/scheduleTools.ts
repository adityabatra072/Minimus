import { NativeModules, Platform } from 'react-native';
import type { ToolDefinition } from '@minimus/agent-core';
import { parseWhen, scheduler } from '../services/scheduler';
import { diag } from '../services/diag';
import {
  formatClock,
  formatDuration,
  nextAlarmFire,
  timerRemainingSeconds,
  useClockStore,
} from '../services/clock';

/**
 * Scheduling tools backed by the MinimusTools native module (Android for now;
 * iOS lands with the AlarmKit module). Schemas stay in lockstep with
 * packages/eval/src/mockTools.ts — the eval scorecards only transfer if these
 * match. create_reminder / schedule_task arrive with the scheduling milestone
 * (they need a persistent task store + AlarmManager receiver).
 */

interface CalendarEventNative {
  title: string;
  startMillis: number;
  endMillis: number;
}

interface MinimusToolsNative {
  setAlarm(hour: number, minute: number, label: string | null): Promise<void>;
  setTimer(seconds: number, label: string | null): Promise<void>;
  notify(title: string, body: string | null): Promise<void>;
  calendarInsert(
    title: string,
    startMillis: number,
    durationMinutes: number,
    notes: string | null,
  ): Promise<string | null>;
  calendarQuery(
    startMillis: number,
    endMillis: number,
  ): Promise<CalendarEventNative[]>;
  reminderCreate?(
    title: string,
    dueMillis: number,
    notes: string | null,
  ): Promise<string>;
  notifyAt?(
    atMillis: number,
    title: string,
    body: string | null,
    identifier: string | null,
  ): Promise<string>;
  cancelNotification?(identifier: string): Promise<void>;
}

function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * Free gaps between events inside waking hours. The TOOL does the clock
 * arithmetic and hands the model plain-language windows — a 2.6B model
 * reasoning over raw ISO timestamps is the single most likely way this
 * demo fails, and it doesn't have to.
 */
function freeGaps(
  events: CalendarEventNative[],
  dayStart: number,
  dayEnd: number,
): { from: string; to: string; minutes: number }[] {
  const busy = [...events].sort((a, b) => a.startMillis - b.startMillis);
  const gaps: { from: string; to: string; minutes: number }[] = [];
  let cursor = dayStart;
  for (const ev of busy) {
    if (ev.startMillis > cursor) {
      const minutes = Math.round(
        (Math.min(ev.startMillis, dayEnd) - cursor) / 60_000,
      );
      if (minutes >= 30) {
        gaps.push({
          from: hhmm(cursor),
          to: hhmm(Math.min(ev.startMillis, dayEnd)),
          minutes,
        });
      }
    }
    cursor = Math.max(cursor, ev.endMillis);
  }
  if (cursor < dayEnd) {
    const minutes = Math.round((dayEnd - cursor) / 60_000);
    if (minutes >= 30)
      gaps.push({ from: hhmm(cursor), to: hhmm(dayEnd), minutes });
  }
  return gaps;
}

function native(): MinimusToolsNative {
  const mod = (NativeModules as Record<string, MinimusToolsNative | undefined>)[
    'MinimusTools'
  ];
  if (!mod)
    throw new Error(`scheduling tools not available on ${Platform.OS} yet`);
  return mod;
}

export function scheduleTools(): ToolDefinition[] {
  return [
    {
      name: 'set_alarm',
      kind: 'action',
      group: 'schedule',
      description:
        'Set an alarm clock that rings at a time of day (a real alarm, like the Clock app). It only rings — it cannot check or do anything.',
      parameters: {
        type: 'object',
        properties: {
          time: { type: 'string', description: '24h HH:MM, e.g. 07:30' },
          label: { type: 'string' },
          repeat: {
            type: 'string',
            enum: ['once', 'daily'],
            description:
              'daily when the user says every day / weekdays / each morning',
          },
        },
        required: ['time'],
      },
      execute: async args => {
        const m = /^(\d{1,2}):(\d{2})$/.exec(String(args['time']).trim());
        if (!m) throw new Error('time must be 24h HH:MM, e.g. 07:30');
        const hour = Number(m[1]);
        const minute = Number(m[2]);
        if (hour > 23 || minute > 59)
          throw new Error('time must be 24h HH:MM, e.g. 07:30');
        const alarm = await useClockStore
          .getState()
          .addAlarm(
            hour,
            minute,
            args['label'] ? String(args['label']) : '',
            args['repeat'] === 'daily',
          );
        return {
          ok: true,
          alarm_set_for: formatClock(hour, minute),
          repeats: alarm.repeatsDaily ? 'daily' : 'once',
          rings_in_minutes: Math.round(
            (nextAlarmFire(alarm) - Date.now()) / 60_000,
          ),
        };
      },
    },
    {
      name: 'set_timer',
      kind: 'action',
      group: 'schedule',
      description:
        'Start a countdown timer that rings when it finishes. It only rings — it cannot check or do anything.',
      parameters: {
        type: 'object',
        properties: {
          minutes: {
            type: 'number',
            description: 'countdown length in minutes',
          },
          label: { type: 'string' },
        },
        required: ['minutes'],
      },
      execute: async args => {
        const minutes = Number(args['minutes']);
        if (!Number.isFinite(minutes) || minutes <= 0)
          throw new Error('minutes must be a positive number');
        const timer = await useClockStore
          .getState()
          .startTimer(
            Math.round(minutes * 60),
            args['label'] ? String(args['label']) : '',
          );
        return {
          ok: true,
          timer_minutes: minutes,
          ends_in: formatDuration(timerRemainingSeconds(timer)),
        };
      },
    },
    {
      name: 'send_notification',
      kind: 'action',
      group: 'schedule',
      description: 'Show a notification on the phone right now',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          body: { type: 'string' },
        },
        required: ['title'],
      },
      execute: async args => {
        await native().notify(
          String(args['title']),
          args['body'] ? String(args['body']) : null,
        );
        return { ok: true };
      },
    },
    {
      name: 'schedule_task',
      kind: 'action',
      group: 'schedule',
      description:
        'Schedule yourself to act later: at the given time you wake up with every tool available and carry out the instruction.',
      usageHint:
        'ANY request of the form "in N minutes / later / at TIME, check X" or "tell me if Y" → schedule_task. set_timer and set_alarm only ring a bell; they cannot check, compare or decide. Putting an event or time block ON THE CALENDAR is calendar_create, never schedule_task.',
      parameters: {
        type: 'object',
        properties: {
          instruction: {
            type: 'string',
            description:
              'what to do when the time comes, written as an instruction to yourself',
          },
          when: {
            type: 'string',
            description:
              'minutes from now as "+N" (use this: "+3" means three minutes from now). "07:30" or an ISO datetime also work but must be in the future',
          },
          repeat: {
            type: 'string',
            enum: ['once', 'daily'],
            description:
              'daily when the user wants this every day at that time',
          },
        },
        required: ['instruction', 'when'],
      },
      execute: async args => {
        const instruction = String(args['instruction']).trim();
        if (!instruction) throw new Error('instruction must not be empty');
        const dueAtMs = parseWhen(String(args['when']));
        // A model that writes an absolute timestamp computes it from when it
        // STARTED thinking, and thinking takes minutes on a phone — device
        // evidence: "in 3 minutes" became when="2026-08-18T02:00:00", and an
        // earlier run armed a task that came due 1.5s later. Refuse the past
        // and say what to send instead, rather than firing immediately and
        // looking broken.
        if (dueAtMs <= Date.now()) {
          throw new Error(
            'that time has already passed — send a relative offset instead, like "+3" for three minutes from now',
          );
        }
        const task = await scheduler.schedule(
          instruction,
          dueAtMs,
          args['repeat'] === 'daily' ? { repeat: 'daily' } : {},
        );
        // iOS suspends the app, so a task due while it is closed cannot run
        // by itself. A notification at the due time brings the user back;
        // the launch runs anything overdue.
        void native()
          .notifyAt?.(
            dueAtMs,
            'Minimus has something to do',
            instruction.slice(0, 120),
            `task-${task.id}`,
          )
          .catch(() => undefined);
        return {
          ok: true,
          task_id: task.id,
          runs_at: hhmm(dueAtMs),
          in_minutes: Math.max(0, Math.round((dueAtMs - Date.now()) / 60_000)),
          ...(task.repeat ? { repeats: 'daily' } : {}),
        };
      },
    },
    {
      name: 'daily_brief',
      kind: 'query',
      group: 'schedule',
      description:
        'Everything about the user\'s day in one call: today\'s calendar, reminders due soon, alarms, and tasks you have scheduled. Use for "what\'s my day", "morning brief", "what\'s on today", "anything I\'m forgetting".',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        const mod = native();
        const kit = (
          NativeModules as Record<
            string,
            | {
                remindersList?: (
                  h: number,
                ) => Promise<
                  { title: string; dueAtMs?: number; list?: string }[]
                >;
              }
            | undefined
          >
        )['MinimusAlarms'];
        const now = new Date();
        const start = new Date(now);
        start.setHours(0, 0, 0, 0);
        const end = new Date(start);
        end.setDate(end.getDate() + 1);
        const [events, reminders, pending] = await Promise.all([
          mod
            .calendarQuery(start.getTime(), end.getTime())
            .catch(() => [] as CalendarEventNative[]),
          kit?.remindersList
            ? kit.remindersList(36).catch(() => [])
            : Promise.resolve([]),
          scheduler.listPending().catch(() => []),
        ]);
        const clock = useClockStore.getState();
        return {
          now: now.toLocaleString([], {
            weekday: 'long',
            hour: 'numeric',
            minute: '2-digit',
          }),
          calendar_today: events
            .filter(e => e.endMillis > now.getTime())
            .slice(0, 8)
            .map(e => ({
              title: e.title,
              at: hhmm(e.startMillis),
              ends: hhmm(e.endMillis),
            })),
          reminders_due: reminders
            .slice(0, 8)
            .map(r => ({
              title: r.title,
              ...(r.dueAtMs
                ? {
                    due: new Date(r.dueAtMs).toLocaleString([], {
                      weekday: 'short',
                      hour: 'numeric',
                      minute: '2-digit',
                    }),
                  }
                : {}),
            })),
          alarms: clock.alarms
            .filter(a => a.enabled)
            .map(
              a =>
                `${formatClock(a.hour, a.minute)}${a.label ? ` ${a.label}` : ''}`,
            ),
          timers: clock.timers
            .filter(t => t.state !== 'done')
            .map(
              t =>
                `${t.label || 'timer'} ${formatDuration(timerRemainingSeconds(t))} left`,
            ),
          scheduled_tasks: pending
            .slice(0, 6)
            .map(t => ({
              instruction: t.instruction.slice(0, 80),
              at: hhmm(t.dueAtMs),
            })),
        };
      },
    },
    {
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
      execute: async args => {
        const mod = native();
        if (!mod.reminderCreate)
          throw new Error('reminders not available on this device');
        const title = String(args['title']).trim();
        if (!title) throw new Error('title must not be empty');
        const dueAtMs = args['when'] ? parseWhen(String(args['when'])) : 0;
        await mod.reminderCreate(
          title,
          dueAtMs,
          args['notes'] ? String(args['notes']) : null,
        );
        return {
          ok: true,
          reminder: title,
          ...(dueAtMs ? { due: hhmm(dueAtMs) } : {}),
        };
      },
    },
    {
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
      execute: async args => {
        const raw = String(args['date'] ?? 'today')
          .trim()
          .toLowerCase();
        const day = new Date();
        if (raw === 'tomorrow') day.setDate(day.getDate() + 1);
        else if (raw !== 'today' && raw !== '') {
          const parsed = new Date(raw);
          if (!Number.isNaN(parsed.getTime())) day.setTime(parsed.getTime());
        }
        const dayStart = new Date(day);
        dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(day);
        dayEnd.setHours(23, 59, 59, 999);

        const events = await native().calendarQuery(
          dayStart.getTime(),
          dayEnd.getTime(),
        );
        const wakingStart = new Date(day);
        wakingStart.setHours(8, 0, 0, 0);
        const wakingEnd = new Date(day);
        wakingEnd.setHours(22, 0, 0, 0);

        const gaps = freeGaps(
          events,
          wakingStart.getTime(),
          wakingEnd.getTime(),
        );
        // The RESULT shape is the diagnosis when a calendar run stalls: a
        // subscribed-calendar avalanche or zero gaps must be visible in syslog.
        diag(
          `calendar_query ${dayStart.toISOString().slice(0, 10)}: ${events.length} events, ${gaps.length} gaps ${JSON.stringify(gaps.map(g => `${g.from}-${g.to}`))}`,
        );
        return {
          date: dayStart.toISOString().slice(0, 10),
          events: events.map(e => ({
            title: e.title,
            from: hhmm(e.startMillis),
            to: hhmm(e.endMillis),
          })),
          free_gaps: gaps,
        };
      },
    },
    {
      name: 'calendar_create',
      kind: 'action',
      group: 'schedule',
      description: 'Book an event or block time on the calendar',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          start: {
            type: 'string',
            description: 'ISO 8601 datetime, e.g. 2026-08-12T15:00:00',
          },
          duration_minutes: { type: 'number' },
          notes: { type: 'string' },
        },
        required: ['title', 'start'],
      },
      execute: async args => {
        const start = new Date(String(args['start']));
        if (Number.isNaN(start.getTime())) {
          throw new Error(
            'start must be an ISO 8601 datetime like 2026-08-12T15:00:00',
          );
        }
        const eventId = await native().calendarInsert(
          String(args['title']),
          start.getTime(),
          args['duration_minutes'] ? Number(args['duration_minutes']) : 60,
          args['notes'] ? String(args['notes']) : null,
        );
        return eventId === 'editor_opened'
          ? { ok: true, status: 'editor_opened_for_confirmation' }
          : { ok: true, event_id: eventId };
      },
    },
  ];
}
