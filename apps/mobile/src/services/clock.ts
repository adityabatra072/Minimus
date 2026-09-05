import { NativeModules, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { diag } from './diag';

/**
 * The clock: alarms, timers and a stopwatch that behave like the Clock app's.
 *
 * On iOS 26 alarms and timers go through AlarmKit, so they ring on the lock
 * screen with a full-screen alert, show a Live Activity countdown, and keep
 * ringing until the user stops them — exactly what the Clock app gets. On
 * older iOS the fallback is a time-sensitive notification (rings once, no
 * countdown). Labels and creation times live here because AlarmKit stores
 * neither; the two lists are reconciled every few seconds while the app is
 * open.
 */

export interface ClockAlarm {
  id: string;
  hour: number;
  minute: number;
  label: string;
  repeatsDaily: boolean;
  enabled: boolean;
  createdAtMs: number;
  /** 'alarmkit' rings like the Clock app; 'notification' is the fallback. */
  backend: 'alarmkit' | 'notification';
  nativeId: string;
}

export interface ClockTimer {
  id: string;
  label: string;
  durationSeconds: number;
  startedAtMs: number;
  /** When paused, the remaining seconds at that moment; undefined when running. */
  pausedRemaining?: number;
  state: 'running' | 'paused' | 'done';
  backend: 'alarmkit' | 'notification';
  nativeId: string;
}

export interface Stopwatch {
  running: boolean;
  /** Accumulated ms before the current run segment. */
  accumulatedMs: number;
  /** Wall-clock start of the current run segment, 0 when stopped. */
  segmentStartMs: number;
  laps: number[];
}

interface AlarmsNative {
  alarmAuthorization(): Promise<'authorized' | 'denied' | 'unavailable'>;
  alarmSchedule(
    hour: number,
    minute: number,
    label: string,
    repeatsDaily: boolean,
  ): Promise<string>;
  timerStart(seconds: number, label: string): Promise<string>;
  alarmList(): Promise<
    {
      id: string;
      state: string;
      kind: 'alarm' | 'timer';
      fireAtMs?: number;
      hour?: number;
      minute?: number;
      durationSeconds?: number;
    }[]
  >;
  alarmCancel(id: string): Promise<void>;
  alarmStop(id: string): Promise<void>;
  alarmPause(id: string): Promise<void>;
  alarmResume(id: string): Promise<void>;
}
interface ToolsNative {
  setAlarm(hour: number, minute: number, label: string | null): Promise<void>;
  setTimer(seconds: number, label: string | null): Promise<void>;
  notifyAt?(
    atMillis: number,
    title: string,
    body: string | null,
    identifier: string | null,
  ): Promise<string>;
  cancelNotification?(identifier: string): Promise<void>;
}

const alarmKit = (NativeModules as Record<string, AlarmsNative | undefined>)[
  'MinimusAlarms'
];
const tools = (NativeModules as Record<string, ToolsNative | undefined>)[
  'MinimusTools'
];

const KEY = 'minimus.clock.v1';

let authState: 'authorized' | 'denied' | 'unavailable' | 'unknown' = 'unknown';

/** Whether AlarmKit (real, Clock-app-grade alarms) is usable on this phone. */
export async function alarmKitAvailable(): Promise<boolean> {
  if (!alarmKit || Platform.OS !== 'ios') return false;
  if (authState === 'unknown') {
    authState = await alarmKit
      .alarmAuthorization()
      .catch(() => 'unavailable' as const);
    diag(`clock: AlarmKit ${authState}`);
  }
  return authState === 'authorized';
}

function id(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function formatClock(hour: number, minute: number): string {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
}

export function timerRemainingSeconds(t: ClockTimer, now = Date.now()): number {
  if (t.state === 'done') return 0;
  if (t.state === 'paused') return t.pausedRemaining ?? 0;
  return Math.max(0, t.durationSeconds - (now - t.startedAtMs) / 1000);
}

/** Next time an enabled alarm fires, in ms since epoch. */
export function nextAlarmFire(a: ClockAlarm, now = new Date()): number {
  const d = new Date(now);
  d.setHours(a.hour, a.minute, 0, 0);
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  return d.getTime();
}

interface ClockState {
  alarms: ClockAlarm[];
  timers: ClockTimer[];
  stopwatch: Stopwatch;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  addAlarm: (
    hour: number,
    minute: number,
    label: string,
    repeatsDaily?: boolean,
  ) => Promise<ClockAlarm>;
  removeAlarm: (alarmId: string) => Promise<void>;
  toggleAlarm: (alarmId: string, enabled: boolean) => Promise<void>;
  startTimer: (seconds: number, label: string) => Promise<ClockTimer>;
  pauseTimer: (timerId: string) => Promise<void>;
  resumeTimer: (timerId: string) => Promise<void>;
  cancelTimer: (timerId: string) => Promise<void>;
  /** Reconcile with AlarmKit; marks finished timers done. */
  sync: () => Promise<void>;
  stopwatchStart: () => void;
  stopwatchStop: () => void;
  stopwatchLap: () => void;
  stopwatchReset: () => void;
}

function persist(state: Pick<ClockState, 'alarms' | 'timers' | 'stopwatch'>) {
  AsyncStorage.setItem(
    KEY,
    JSON.stringify({
      alarms: state.alarms,
      timers: state.timers,
      stopwatch: state.stopwatch,
    }),
  ).catch(() => undefined);
}

export const useClockStore = create<ClockState>((set, get) => ({
  alarms: [],
  timers: [],
  stopwatch: { running: false, accumulatedMs: 0, segmentStartMs: 0, laps: [] },
  hydrated: false,

  hydrate: async () => {
    try {
      const raw = await AsyncStorage.getItem(KEY);
      if (raw) {
        const saved = JSON.parse(raw) as Partial<
          Pick<ClockState, 'alarms' | 'timers' | 'stopwatch'>
        >;
        set({
          alarms: saved.alarms ?? [],
          // A timer that was done when we quit does not need to come back.
          timers: (saved.timers ?? []).filter(t => t.state !== 'done'),
          stopwatch: saved.stopwatch ?? get().stopwatch,
        });
      }
    } catch {
      /* corrupt clock state — start clean */
    }
    set({ hydrated: true });
    await get().sync();
  },

  addAlarm: async (hour, minute, label, repeatsDaily = false) => {
    const useKit = await alarmKitAvailable();
    let nativeId = '';
    if (useKit && alarmKit) {
      nativeId = await alarmKit.alarmSchedule(
        hour,
        minute,
        label,
        repeatsDaily,
      );
    } else {
      if (!tools) throw new Error('alarms are not available on this device');
      await tools.setAlarm(hour, minute, label || null);
    }
    const alarm: ClockAlarm = {
      id: id(),
      hour,
      minute,
      label,
      repeatsDaily,
      enabled: true,
      createdAtMs: Date.now(),
      backend: useKit ? 'alarmkit' : 'notification',
      nativeId,
    };
    const alarms = [...get().alarms, alarm].sort(
      (a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute),
    );
    set({ alarms });
    persist({ ...get(), alarms });
    diag(`clock: alarm ${formatClock(hour, minute)} via ${alarm.backend}`);
    return alarm;
  },

  removeAlarm: async alarmId => {
    const alarm = get().alarms.find(a => a.id === alarmId);
    if (!alarm) return;
    if (alarm.backend === 'alarmkit' && alarm.nativeId)
      await alarmKit?.alarmCancel(alarm.nativeId).catch(() => undefined);
    const alarms = get().alarms.filter(a => a.id !== alarmId);
    set({ alarms });
    persist({ ...get(), alarms });
  },

  toggleAlarm: async (alarmId, enabled) => {
    const alarm = get().alarms.find(a => a.id === alarmId);
    if (!alarm || alarm.enabled === enabled) return;
    let nativeId = alarm.nativeId;
    if (alarm.backend === 'alarmkit' && alarmKit) {
      if (enabled)
        nativeId = await alarmKit.alarmSchedule(
          alarm.hour,
          alarm.minute,
          alarm.label,
          alarm.repeatsDaily,
        );
      else if (nativeId)
        await alarmKit.alarmCancel(nativeId).catch(() => undefined);
    } else if (enabled && tools) {
      await tools.setAlarm(alarm.hour, alarm.minute, alarm.label || null);
    }
    const alarms = get().alarms.map(a =>
      a.id === alarmId ? { ...a, enabled, nativeId } : a,
    );
    set({ alarms });
    persist({ ...get(), alarms });
  },

  startTimer: async (seconds, label) => {
    const useKit = await alarmKitAvailable();
    let nativeId = '';
    if (useKit && alarmKit) {
      nativeId = await alarmKit.timerStart(seconds, label);
    } else {
      if (!tools) throw new Error('timers are not available on this device');
      await tools.setTimer(seconds, label || null);
    }
    const timer: ClockTimer = {
      id: id(),
      label,
      durationSeconds: seconds,
      startedAtMs: Date.now(),
      state: 'running',
      backend: useKit ? 'alarmkit' : 'notification',
      nativeId,
    };
    const timers = [...get().timers.filter(t => t.state !== 'done'), timer];
    set({ timers });
    persist({ ...get(), timers });
    diag(`clock: timer ${formatDuration(seconds)} via ${timer.backend}`);
    return timer;
  },

  pauseTimer: async timerId => {
    const t = get().timers.find(x => x.id === timerId);
    if (!t || t.state !== 'running') return;
    if (t.backend === 'alarmkit')
      await alarmKit?.alarmPause(t.nativeId).catch(() => undefined);
    const timers = get().timers.map(x =>
      x.id === timerId
        ? {
            ...x,
            state: 'paused' as const,
            pausedRemaining: timerRemainingSeconds(x),
          }
        : x,
    );
    set({ timers });
    persist({ ...get(), timers });
  },

  resumeTimer: async timerId => {
    const t = get().timers.find(x => x.id === timerId);
    if (!t || t.state !== 'paused') return;
    if (t.backend === 'alarmkit')
      await alarmKit?.alarmResume(t.nativeId).catch(() => undefined);
    const remaining = t.pausedRemaining ?? 0;
    const timers = get().timers.map(x =>
      x.id === timerId
        ? {
            ...x,
            state: 'running' as const,
            pausedRemaining: undefined,
            durationSeconds: remaining,
            startedAtMs: Date.now(),
          }
        : x,
    );
    set({ timers });
    persist({ ...get(), timers });
  },

  cancelTimer: async timerId => {
    const t = get().timers.find(x => x.id === timerId);
    if (!t) return;
    if (t.backend === 'alarmkit' && t.nativeId) {
      await alarmKit?.alarmStop(t.nativeId).catch(() => undefined);
      await alarmKit?.alarmCancel(t.nativeId).catch(() => undefined);
    }
    const timers = get().timers.filter(x => x.id !== timerId);
    set({ timers });
    persist({ ...get(), timers });
  },

  sync: async () => {
    const now = Date.now();
    let timers = get().timers.map(t =>
      t.state === 'running' && timerRemainingSeconds(t, now) <= 0
        ? { ...t, state: 'done' as const }
        : t,
    );
    let alarms = get().alarms;
    if (await alarmKitAvailable()) {
      const live = await alarmKit!.alarmList().catch(() => null);
      if (live) {
        const liveIds = new Set(live.map(l => l.id));
        // A one-shot alarm the user stopped from the lock screen is gone from
        // AlarmKit; show it switched off rather than pretending it will ring.
        alarms = alarms.map(a =>
          a.backend === 'alarmkit' &&
          a.enabled &&
          !a.repeatsDaily &&
          a.nativeId &&
          !liveIds.has(a.nativeId)
            ? { ...a, enabled: false }
            : a,
        );
        timers = timers.map(t => {
          if (t.backend !== 'alarmkit' || t.state === 'done') return t;
          const l = live.find(x => x.id === t.nativeId);
          if (!l) return { ...t, state: 'done' as const };
          if (l.state === 'paused' && t.state === 'running')
            return {
              ...t,
              state: 'paused' as const,
              pausedRemaining: timerRemainingSeconds(t, now),
            };
          if (l.state === 'countdown' && t.state === 'paused')
            return {
              ...t,
              state: 'running' as const,
              pausedRemaining: undefined,
              durationSeconds: t.pausedRemaining ?? 0,
              startedAtMs: now,
            };
          return t;
        });
      }
    }
    const changed =
      JSON.stringify(timers) !== JSON.stringify(get().timers) ||
      JSON.stringify(alarms) !== JSON.stringify(get().alarms);
    if (changed) {
      set({ timers, alarms });
      persist({ ...get(), timers, alarms });
    }
  },

  stopwatchStart: () => {
    const sw = get().stopwatch;
    if (sw.running) return;
    const stopwatch = { ...sw, running: true, segmentStartMs: Date.now() };
    set({ stopwatch });
    persist({ ...get(), stopwatch });
  },
  stopwatchStop: () => {
    const sw = get().stopwatch;
    if (!sw.running) return;
    const stopwatch = {
      ...sw,
      running: false,
      accumulatedMs: sw.accumulatedMs + (Date.now() - sw.segmentStartMs),
      segmentStartMs: 0,
    };
    set({ stopwatch });
    persist({ ...get(), stopwatch });
  },
  stopwatchLap: () => {
    const sw = get().stopwatch;
    const elapsed =
      sw.accumulatedMs + (sw.running ? Date.now() - sw.segmentStartMs : 0);
    const stopwatch = { ...sw, laps: [...sw.laps, elapsed] };
    set({ stopwatch });
    persist({ ...get(), stopwatch });
  },
  stopwatchReset: () => {
    const stopwatch = {
      running: false,
      accumulatedMs: 0,
      segmentStartMs: 0,
      laps: [],
    };
    set({ stopwatch });
    persist({ ...get(), stopwatch });
  },
}));

export function stopwatchElapsedMs(sw: Stopwatch, now = Date.now()): number {
  return sw.accumulatedMs + (sw.running ? now - sw.segmentStartMs : 0);
}

export function formatStopwatch(ms: number): string {
  const total = Math.max(0, ms);
  const m = Math.floor(total / 60_000);
  const s = Math.floor((total % 60_000) / 1000);
  const cs = Math.floor((total % 1000) / 10);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

/** What the chat header should show: the soonest running timer, else the next alarm. */
export function clockHeadline(
  state: Pick<ClockState, 'alarms' | 'timers'>,
  now = Date.now(),
): { kind: 'timer' | 'alarm'; text: string; id: string } | null {
  const running = state.timers.filter(
    t => t.state === 'running' || t.state === 'paused',
  );
  if (running.length > 0) {
    const soonest = running.reduce((a, b) =>
      timerRemainingSeconds(a, now) <= timerRemainingSeconds(b, now) ? a : b,
    );
    const rest = running.length > 1 ? ` +${running.length - 1}` : '';
    return {
      kind: 'timer',
      id: soonest.id,
      text: `${formatDuration(timerRemainingSeconds(soonest, now))}${soonest.state === 'paused' ? ' paused' : ''}${rest}`,
    };
  }
  const enabled = state.alarms.filter(a => a.enabled);
  if (enabled.length > 0) {
    const next = enabled.reduce((a, b) =>
      nextAlarmFire(a) <= nextAlarmFire(b) ? a : b,
    );
    return {
      kind: 'alarm',
      id: next.id,
      text: formatClock(next.hour, next.minute),
    };
  }
  return null;
}
