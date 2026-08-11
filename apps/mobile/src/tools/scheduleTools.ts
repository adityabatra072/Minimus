import { NativeModules, Platform } from 'react-native';
import type { ToolDefinition } from '@minimus/agent-core';

/**
 * Scheduling tools backed by the MinimusTools native module (Android for now;
 * iOS lands with the AlarmKit module). Schemas stay in lockstep with
 * packages/eval/src/mockTools.ts — the eval scorecards only transfer if these
 * match. create_reminder / schedule_task arrive with the scheduling milestone
 * (they need a persistent task store + AlarmManager receiver).
 */

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
}

function native(): MinimusToolsNative {
  const mod = (NativeModules as Record<string, MinimusToolsNative | undefined>)['MinimusTools'];
  if (!mod) throw new Error(`scheduling tools not available on ${Platform.OS} yet`);
  return mod;
}

export function scheduleTools(): ToolDefinition[] {
  return [
    {
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
      execute: async (args) => {
        const m = /^(\d{1,2}):(\d{2})$/.exec(String(args['time']).trim());
        if (!m) throw new Error('time must be 24h HH:MM, e.g. 07:30');
        await native().setAlarm(Number(m[1]), Number(m[2]), args['label'] ? String(args['label']) : null);
        return { ok: true, alarm_set_for: args['time'] };
      },
    },
    {
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
      execute: async (args) => {
        const minutes = Number(args['minutes']);
        if (!Number.isFinite(minutes) || minutes <= 0) throw new Error('minutes must be a positive number');
        await native().setTimer(Math.round(minutes * 60), args['label'] ? String(args['label']) : null);
        return { ok: true, timer_minutes: minutes };
      },
    },
    {
      name: 'send_notification',
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
      execute: async (args) => {
        await native().notify(String(args['title']), args['body'] ? String(args['body']) : null);
        return { ok: true };
      },
    },
    {
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
      execute: async (args) => {
        const start = new Date(String(args['start']));
        if (Number.isNaN(start.getTime())) {
          throw new Error('start must be an ISO 8601 datetime like 2026-08-12T15:00:00');
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
