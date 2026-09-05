import { NativeModules, Platform } from 'react-native';
import type { ToolDefinition } from '@minimus/agent-core';
import { parseWhen, scheduler } from '../services/scheduler';
import { diag } from '../services/diag';
import {
  findAlarms,
  findTimers,
  formatClock,
  formatDuration,
  nextAlarmFire,
  parseClockTime,
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
        'Set a NEW alarm that rings at a time of day (a real alarm, like the Clock app). It only rings — it cannot check or do anything. To move or remove an existing alarm use change_alarm / cancel_alarm.',
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
      name: 'list_alarms',
      kind: 'query',
      group: 'schedule',
      description: 'Every alarm and running timer on the phone: times, labels, on/off, time left.',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        const c = useClockStore.getState();
        return {
          alarms: c.alarms.map(a => ({
            time: formatClock(a.hour, a.minute),
            label: a.label || undefined,
            enabled: a.enabled,
            repeats: a.repeatsDaily ? 'daily' : 'once',
          })),
          timers: c.timers
            .filter(t => t.state !== 'done')
            .map(t => ({ label: t.label || 'timer', remaining: formatDuration(timerRemainingSeconds(t)), state: t.state })),
        };
      },
    },
    {
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
      execute: async args => {
        const c = useClockStore.getState();
        let hits = args['all'] === true ? c.alarms : findAlarms(c.alarms, { ...(args['time'] ? { time: String(args['time']) } : {}), ...(args['label'] ? { label: String(args['label']) } : {}) });
        if (!args['all'] && !args['time'] && !args['label']) hits = hits.filter(a => a.enabled);
        const listed = (xs: typeof c.alarms) => xs.map(a => `${formatClock(a.hour, a.minute)}${a.label ? ` (${a.label})` : ''}`).join(', ');
        if (hits.length === 0) {
          throw new Error(c.alarms.length === 0 ? 'No alarm is set.' : `No alarm is set for that. Alarms: ${listed(c.alarms)}.`);
        }
        if (hits.length > 1 && !args['all']) {
          throw new Error(`Several alarms match (${listed(hits)}). Ask the user which one, or cancel all.`);
        }
        const removed: string[] = [];
        for (const a of hits) {
          if (args['disable_only'] === true) await c.toggleAlarm(a.id, false);
          else await c.removeAlarm(a.id);
          removed.push(`${formatClock(a.hour, a.minute)}${a.label ? ` ${a.label}` : ''}`);
        }
        return { ok: true, removed, ...(args['disable_only'] === true ? { disabled_only: true } : {}), remaining_alarms: useClockStore.getState().alarms.filter(a => a.enabled).length };
      },
    },
    {
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
      execute: async args => {
        const c = useClockStore.getState();
        let hits = findAlarms(c.alarms, { ...(args['time'] ? { time: String(args['time']) } : {}), ...(args['label'] ? { label: String(args['label']) } : {}) });
        // With a single alarm there is nothing to disambiguate: take it even
        // when the model put the NEW time in `time` (seen on device: "move my
        // alarm to 7:15" arrived as time="07:15", no new_time).
        if (hits.length === 0 && c.alarms.length === 1) {
          hits = c.alarms;
          if (args['time'] && !args['new_time']) args = { ...args, new_time: args['time'] };
        }
        if (hits.length !== 1) {
          const listed = c.alarms.map(a => `${formatClock(a.hour, a.minute)}${a.label ? ` (${a.label})` : ''}`).join(', ');
          if (hits.length === 0) throw new Error(c.alarms.length === 0 ? 'No alarm is set; use set_alarm to create one.' : `No alarm matches that time. Alarms: ${listed}.`);
          throw new Error(`Several alarms match (${listed}). Ask the user which one.`);
        }
        const target = hits[0]!;
        const patch: { hour?: number; minute?: number; label?: string; repeatsDaily?: boolean } = {};
        if (args['new_time']) {
          const t = parseClockTime(String(args['new_time']));
          if (!t) throw new Error('new_time must be 24h HH:MM, e.g. 07:30');
          patch.hour = t.hour;
          patch.minute = t.minute;
        }
        if (typeof args['new_label'] === 'string') patch.label = String(args['new_label']);
        if (args['repeat'] === 'daily' || args['repeat'] === 'once') patch.repeatsDaily = args['repeat'] === 'daily';
        let updated = target;
        if (Object.keys(patch).length > 0) updated = await c.updateAlarm(target.id, patch);
        if (typeof args['enabled'] === 'boolean') {
          await c.toggleAlarm(target.id, args['enabled']);
          updated = { ...updated, enabled: args['enabled'] };
        }
        return { ok: true, was: formatClock(target.hour, target.minute), now: formatClock(updated.hour, updated.minute), label: updated.label || undefined, repeats: updated.repeatsDaily ? 'daily' : 'once', enabled: updated.enabled };
      },
    },
    {
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
      execute: async args => {
        const c = useClockStore.getState();
        const action = String(args['action']);
        let hits = findTimers(c.timers, args['label'] ? String(args['label']) : undefined);
        if (hits.length === 0) throw new Error('No timer is running.');
        if (hits.length > 1 && !args['all'] && !args['label'] && (action === 'add_minutes' || action === 'cancel')) {
          throw new Error(`Several timers are running (${hits.map(t => `${t.label || 'timer'} ${formatDuration(timerRemainingSeconds(t))}`).join(', ')}). Ask the user which one, or use all.`);
        }
        if (!args['all'] && hits.length > 1) hits = [hits[0]!];
        const done: string[] = [];
        for (const t of hits) {
          const name = t.label || 'timer';
          if (action === 'pause') await c.pauseTimer(t.id);
          else if (action === 'resume') await c.resumeTimer(t.id);
          else if (action === 'cancel') await c.cancelTimer(t.id);
          else if (action === 'add_minutes') {
            const mins = Number(args['minutes']);
            if (!Number.isFinite(mins) || mins === 0) throw new Error('minutes must be a non-zero number');
            const next = await c.extendTimer(t.id, Math.round(mins * 60));
            done.push(`${name}: now ${formatDuration(timerRemainingSeconds(next))} left`);
            continue;
          } else throw new Error('action must be pause, resume, cancel or add_minutes');
          done.push(`${name}: ${action}${action === 'cancel' ? 'led' : 'd'}`);
        }
        return { ok: true, action, timers: done };
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
