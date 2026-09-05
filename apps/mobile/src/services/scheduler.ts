import AsyncStorage from '@react-native-async-storage/async-storage';
import { NativeModules } from 'react-native';
import { isRunBusy } from './runLock';

/**
 * Deferred agency: the agent schedules ITSELF to act later.
 *
 * A scheduled task stores an instruction ("check my battery and tell me if
 * it's under 50%"). When it comes due, the scheduler runs a COMPLETE agent
 * loop with the full tool set, then delivers the outcome as a notification
 * and an inline chat entry. The model decides at fire time — this is not a
 * pre-baked reminder, which is exactly what makes it something no
 * command-parser assistant can do.
 *
 * Honest limit: execution requires the app process to be alive (foreground,
 * or the OS's brief background grace). A killed app resumes pending tasks on
 * next launch and runs anything overdue.
 */

const KEY = 'minimus.scheduledTasks.v1';
const TICK_MS = 5000;

export interface ScheduledTask {
  id: string;
  instruction: string;
  dueAtMs: number;
  createdAtMs: number;
  status: 'pending' | 'running' | 'done' | 'failed';
  result?: string;
}

/** Runs one agent turn for a scheduled instruction; returns the final answer. */
export type TaskRunner = (instruction: string) => Promise<string>;

type Listener = (task: ScheduledTask) => void;

let runner: TaskRunner | null = null;
let ticking: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<Listener>();

async function loadAll(): Promise<ScheduledTask[]> {
  const raw = await AsyncStorage.getItem(KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as ScheduledTask[];
  } catch {
    return [];
  }
}

async function saveAll(tasks: ScheduledTask[]): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(tasks));
}

async function update(id: string, patch: Partial<ScheduledTask>): Promise<ScheduledTask | null> {
  const tasks = await loadAll();
  const idx = tasks.findIndex((t) => t.id === id);
  if (idx === -1) return null;
  const next = { ...tasks[idx]!, ...patch };
  tasks[idx] = next;
  await saveAll(tasks);
  return next;
}

function notify(title: string, body: string): void {
  const native = (NativeModules as Record<string, { notify?: (t: string, b: string | null) => Promise<unknown> }>)[
    'MinimusTools'
  ];
  native?.notify?.(title, body).catch(() => undefined);
}

/**
 * Parse the model's `when`: "+30" / "30" / "30 minutes" (relative minutes),
 * "HH:MM" (next occurrence today or tomorrow), "tomorrow 12:15" / "+1d 12:15"
 * (a day offset with an optional clock time), or an ISO datetime.
 */
export function parseWhen(when: string, now = new Date()): number {
  const raw = String(when).trim();

  const relative = /^\+?(\d+(?:\.\d+)?)\s*(m|min|mins|minute|minutes)?$/i.exec(raw);
  if (relative) {
    return now.getTime() + Math.round(parseFloat(relative[1]!) * 60_000);
  }
  const seconds = /^\+?(\d+)\s*(s|sec|secs|seconds)$/i.exec(raw);
  if (seconds) {
    return now.getTime() + parseInt(seconds[1]!, 10) * 1000;
  }
  const hours = /^\+?(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours)$/i.exec(raw);
  if (hours) {
    return now.getTime() + Math.round(parseFloat(hours[1]!) * 3_600_000);
  }
  const clock = /^(\d{1,2}):(\d{2})$/.exec(raw);
  if (clock) {
    const target = new Date(now);
    target.setHours(parseInt(clock[1]!, 10), parseInt(clock[2]!, 10), 0, 0);
    if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
    return target.getTime();
  }
  // "tomorrow 12:15", "+1d 12:15", "+2d" — a day offset with an optional
  // clock time. Device evidence: asked to put something on tomorrow's
  // calendar, the model sent when="+1d 12:15" twice in a row and the tool
  // rejected it both times. Every accepted format could express minutes from
  // now or a time TODAY, and none could say "tomorrow at 12:15" except a full
  // ISO datetime, which the model never reached for. That was a gap in what
  // the tool accepts, not only a mistake by the model.
  const dayOffset = /^(?:\+(\d+)\s*d|tomorrow|today)\s*(?:at\s*)?(?:(\d{1,2}):(\d{2}))?$/i.exec(raw);
  if (dayOffset) {
    const days = dayOffset[1] !== undefined
      ? parseInt(dayOffset[1], 10)
      : /^tomorrow/i.test(raw)
        ? 1
        : 0;
    const target = new Date(now);
    target.setDate(target.getDate() + days);
    if (dayOffset[2] !== undefined && dayOffset[3] !== undefined) {
      target.setHours(parseInt(dayOffset[2], 10), parseInt(dayOffset[3], 10), 0, 0);
    }
    if (target.getTime() > now.getTime()) return target.getTime();
  }
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) return parsed.getTime();

  throw new Error(
    'when must be "+N" (minutes from now), "HH:MM", "tomorrow HH:MM", or an ISO datetime. ' +
      'To put an event on the calendar, use calendar_create instead.',
  );
}

export const scheduler = {
  /** Register the agent-loop runner (called once from the chat screen). */
  setRunner(fn: TaskRunner): void {
    runner = fn;
  },

  onTaskEvent(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  async schedule(instruction: string, dueAtMs: number): Promise<ScheduledTask> {
    const task: ScheduledTask = {
      id: `t_${Date.now().toString(36)}`,
      instruction,
      dueAtMs,
      createdAtMs: Date.now(),
      status: 'pending',
    };
    const tasks = await loadAll();
    tasks.push(task);
    await saveAll(tasks);
    return task;
  },

  async listPending(): Promise<ScheduledTask[]> {
    return (await loadAll()).filter((t) => t.status === 'pending');
  },

  async cancel(id: string): Promise<void> {
    await saveAll((await loadAll()).filter((t) => t.id !== id));
    const mod = (NativeModules as Record<string, { cancelNotification?: (id: string) => Promise<void> }>)['MinimusTools'];
    void mod?.cancelNotification?.(`task-${id}`).catch(() => undefined);
  },

  /** Start the due-task poller. Safe to call more than once. */
  start(): void {
    if (ticking) return;
    ticking = setInterval(() => {
      void scheduler.tick();
    }, TICK_MS);
  },

  stop(): void {
    if (ticking) clearInterval(ticking);
    ticking = null;
  },

  /** Fire every task that has come due. Exposed for tests and cold starts. */
  async tick(): Promise<void> {
    if (!runner) return;
    // A due task must never start a second generation on top of a running one
    // — the native LLM has one context and the two interleave. Leave it
    // pending; the next tick picks it up. Seen firing 1.5s into a rehearsal
    // beat's wrap-up turn (services/runLock).
    if (isRunBusy()) return;
    const due = (await loadAll()).filter((t) => t.status === 'pending' && t.dueAtMs <= Date.now());
    for (const task of due) {
      const running = await update(task.id, { status: 'running' });
      if (running) listeners.forEach((l) => l(running));
      try {
        const result = await runner(task.instruction);
        const done = await update(task.id, { status: 'done', result });
        if (done) {
          listeners.forEach((l) => l(done));
          notify('Scheduled task done', result.slice(0, 180) || task.instruction);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const failed = await update(task.id, { status: 'failed', result: message });
        if (failed) {
          listeners.forEach((l) => l(failed));
          notify('Scheduled task failed', message.slice(0, 180));
        }
      }
    }
  },
};
