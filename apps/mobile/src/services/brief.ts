import { NativeModules } from 'react-native';
import { scheduler } from './scheduler';
import { useSettingsStore } from '../stores/settingsStore';

/**
 * The morning brief: one recurring scheduled task, tagged so changing the
 * time replaces it instead of stacking a second one. The task runs through
 * the same agent loop as anything else, so it uses `daily_brief` and talks
 * about the day in the user's own context (memory facts included).
 */

export const BRIEF_TAG = 'daily-brief';
export const BRIEF_INSTRUCTION =
  'Give me my morning brief. Call daily_brief, then tell me about my day in a few warm sentences: what is on the calendar, reminders due, alarms, anything scheduled. Mention the first thing that needs attention. No lists.';

function nextOccurrence(hhmm: string, now = new Date()): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return 0;
  const d = new Date(now);
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** Set (or clear, with '') the daily brief time. */
export async function setDailyBrief(hhmm: string): Promise<void> {
  await scheduler.cancelTagged(BRIEF_TAG);
  useSettingsStore.getState().setBriefTime(hhmm);
  if (!hhmm) return;
  const at = nextOccurrence(hhmm);
  if (!at) return;
  const task = await scheduler.schedule(BRIEF_INSTRUCTION, at, {
    repeat: 'daily',
    tag: BRIEF_TAG,
  });
  const mod = (
    NativeModules as Record<
      string,
      | {
          notifyAt?: (
            at: number,
            t: string,
            b: string | null,
            id: string | null,
          ) => Promise<string>;
        }
      | undefined
    >
  )['MinimusTools'];
  void mod
    ?.notifyAt?.(
      at,
      'Your morning brief is ready',
      'Open Minimus to hear about your day.',
      `task-${task.id}`,
    )
    .catch(() => undefined);
}
