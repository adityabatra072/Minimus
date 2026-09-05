import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  formatClock,
  formatDuration,
  formatStopwatch,
  nextAlarmFire,
  stopwatchElapsedMs,
  timerRemainingSeconds,
  useClockStore,
} from '../services/clock';
import { radius, space, usePalette } from '../theme';
import {
  Button,
  Chip,
  Field,
  Header,
  Label,
  Row,
  Screen,
  Segmented,
  Toggle,
} from '../ui/primitives';
import { GlyphX } from '../ui/glyphs';

/**
 * Clock — alarms, timers, stopwatch. The same things the Clock app does, but
 * the agent can set them for you and they show up here. Alarms and timers
 * ring through AlarmKit on iOS 26 (lock-screen alert, Live Activity
 * countdown); the screen says so when it is running on the older fallback.
 */

type Tab = 'alarms' | 'timers' | 'stopwatch';

function useNow(intervalMs: number, active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs, active]);
  return now;
}

function relative(ms: number): string {
  const mins = Math.round((ms - Date.now()) / 60_000);
  if (mins < 60) return `in ${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `in ${h}h${m ? ` ${m}m` : ''}`;
}

export default function ClockScreen({
  onClose,
  initialTab = 'timers',
}: {
  onClose: () => void;
  initialTab?: Tab;
}): React.JSX.Element {
  const p = usePalette();
  const [tab, setTab] = useState<Tab>(initialTab);
  const alarms = useClockStore(s => s.alarms);
  const timers = useClockStore(s => s.timers);
  const stopwatch = useClockStore(s => s.stopwatch);
  const sync = useClockStore(s => s.sync);
  const activeTimers = timers.filter(t => t.state !== 'done');
  const now = useNow(
    tab === 'stopwatch' ? 50 : 500,
    tab === 'stopwatch' ? stopwatch.running : activeTimers.length > 0,
  );

  useEffect(() => {
    void sync();
    const t = setInterval(() => void sync(), 4000);
    return () => clearInterval(t);
  }, [sync]);

  const backendNote = useMemo(() => {
    const all = [...alarms, ...timers];
    if (all.length === 0) return null;
    return all.some(x => x.backend === 'notification')
      ? 'Rings as a notification on this iOS version. iOS 26 rings like the Clock app.'
      : null;
  }, [alarms, timers]);

  return (
    <Screen>
      <Header
        title="Clock"
        eyebrow={backendNote ?? undefined}
        onClose={onClose}
      />
      <View style={styles.tabs}>
        <Segmented
          options={[
            {
              value: 'alarms',
              label: `Alarms${alarms.length ? ` · ${alarms.length}` : ''}`,
            },
            {
              value: 'timers',
              label: `Timers${activeTimers.length ? ` · ${activeTimers.length}` : ''}`,
            },
            { value: 'stopwatch', label: 'Stopwatch' },
          ]}
          value={tab}
          onChange={setTab}
        />
      </View>
      <ScrollView
        contentContainerStyle={styles.body}
        keyboardShouldPersistTaps="handled"
      >
        {tab === 'alarms' ? (
          <Alarms />
        ) : tab === 'timers' ? (
          <Timers now={now} />
        ) : (
          <StopwatchView now={now} />
        )}
      </ScrollView>
    </Screen>
  );
}

// ---------------------------------------------------------------------------

function Alarms(): React.JSX.Element {
  const p = usePalette();
  const alarms = useClockStore(s => s.alarms);
  const addAlarm = useClockStore(s => s.addAlarm);
  const removeAlarm = useClockStore(s => s.removeAlarm);
  const toggleAlarm = useClockStore(s => s.toggleAlarm);
  const [adding, setAdding] = useState(alarms.length === 0);
  const [hour, setHour] = useState(7);
  const [minute, setMinute] = useState(0);
  const [label, setLabel] = useState('');
  const [daily, setDaily] = useState(false);
  const [error, setError] = useState('');

  const step = (h: number, m: number) => {
    let total = hour * 60 + minute + h * 60 + m;
    total = ((total % 1440) + 1440) % 1440;
    setHour(Math.floor(total / 60));
    setMinute(total % 60);
  };

  return (
    <View style={{ gap: space(4) }}>
      {alarms.length > 0 ? (
        <View>
          {alarms.map((a, i) => (
            <Row
              key={a.id}
              title={`${formatClock(a.hour, a.minute)}${a.label ? ` · ${a.label}` : ''}`}
              subtitle={
                a.enabled
                  ? `${a.repeatsDaily ? 'Every day' : 'Once'} · ${relative(nextAlarmFire(a))}`
                  : 'Off'
              }
              first={i === 0}
              last={i === alarms.length - 1}
              right={
                <View style={styles.rowRight}>
                  <Toggle
                    value={a.enabled}
                    onChange={on => void toggleAlarm(a.id, on)}
                  />
                  <Pressable
                    hitSlop={10}
                    onPress={() => void removeAlarm(a.id)}
                    accessibilityRole="button"
                    accessibilityLabel="Delete alarm"
                  >
                    <GlyphX color={p.ink3} size={14} />
                  </Pressable>
                </View>
              }
            />
          ))}
        </View>
      ) : null}

      {adding ? (
        <View
          style={[
            styles.card,
            { backgroundColor: p.surface, borderColor: p.line },
          ]}
        >
          <Label>new alarm</Label>
          <Text style={[styles.bigTime, { color: p.ink }]}>
            {formatClock(hour, minute)}
          </Text>
          <View style={styles.steppers}>
            <Stepper
              label="hour"
              onDown={() => step(-1, 0)}
              onUp={() => step(1, 0)}
            />
            <Stepper
              label="5 min"
              onDown={() => step(0, -5)}
              onUp={() => step(0, 5)}
            />
            <Stepper
              label="1 min"
              onDown={() => step(0, -1)}
              onUp={() => step(0, 1)}
            />
          </View>
          <View style={styles.chips}>
            {[
              [6, 30],
              [7, 0],
              [7, 30],
              [8, 0],
              [9, 0],
              [22, 30],
            ].map(([h, m]) => (
              <Chip
                key={`${h}:${m}`}
                label={formatClock(h!, m!)}
                active={hour === h && minute === m}
                onPress={() => {
                  setHour(h!);
                  setMinute(m!);
                }}
              />
            ))}
          </View>
          <Field
            label="Label (optional)"
            value={label}
            placeholder="Wake up"
            onChangeText={setLabel}
          />
          <Row
            title="Every day"
            right={<Toggle value={daily} onChange={setDaily} />}
            first
            last
          />
          {error ? <Text style={{ color: p.danger }}>{error}</Text> : null}
          <View style={styles.actions}>
            {alarms.length > 0 ? (
              <Button
                label="Cancel"
                kind="ghost"
                onPress={() => setAdding(false)}
              />
            ) : null}
            <Button
              label="Set alarm"
              onPress={() => {
                setError('');
                addAlarm(hour, minute, label.trim(), daily)
                  .then(() => {
                    setAdding(false);
                    setLabel('');
                  })
                  .catch(err =>
                    setError(err instanceof Error ? err.message : String(err)),
                  );
              }}
            />
          </View>
        </View>
      ) : (
        <Button label="New alarm" onPress={() => setAdding(true)} />
      )}
      <Text style={[styles.hint, { color: p.ink3 }]}>
        Or just say it: “wake me at 6:45”, “alarm at 7 every day”.
      </Text>
    </View>
  );
}

function Stepper({
  label,
  onDown,
  onUp,
}: {
  label: string;
  onDown: () => void;
  onUp: () => void;
}): React.JSX.Element {
  const p = usePalette();
  return (
    <View style={styles.stepper}>
      <Pressable
        onPress={onUp}
        style={[styles.stepBtn, { backgroundColor: p.surface2 }]}
        accessibilityRole="button"
        accessibilityLabel={`${label} up`}
      >
        <Text style={[styles.stepText, { color: p.ink }]}>+</Text>
      </Pressable>
      <Text style={[styles.stepLabel, { color: p.ink3 }]}>{label}</Text>
      <Pressable
        onPress={onDown}
        style={[styles.stepBtn, { backgroundColor: p.surface2 }]}
        accessibilityRole="button"
        accessibilityLabel={`${label} down`}
      >
        <Text style={[styles.stepText, { color: p.ink }]}>−</Text>
      </Pressable>
    </View>
  );
}

// ---------------------------------------------------------------------------

function Timers({ now }: { now: number }): React.JSX.Element {
  const p = usePalette();
  const timers = useClockStore(s => s.timers);
  const startTimer = useClockStore(s => s.startTimer);
  const pauseTimer = useClockStore(s => s.pauseTimer);
  const resumeTimer = useClockStore(s => s.resumeTimer);
  const cancelTimer = useClockStore(s => s.cancelTimer);
  const [custom, setCustom] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState('');
  const active = timers.filter(t => t.state !== 'done');
  const done = timers.filter(t => t.state === 'done');

  const start = (minutes: number) => {
    setError('');
    startTimer(Math.round(minutes * 60), label.trim())
      .then(() => setLabel(''))
      .catch(err => setError(err instanceof Error ? err.message : String(err)));
  };

  return (
    <View style={{ gap: space(4) }}>
      {active.map(t => {
        const remaining = timerRemainingSeconds(t, now);
        const frac = t.durationSeconds > 0 ? remaining / t.durationSeconds : 0;
        return (
          <View
            key={t.id}
            style={[
              styles.card,
              {
                backgroundColor: p.surface,
                borderColor: t.state === 'paused' ? p.line : p.live,
              },
            ]}
          >
            <View style={styles.timerHead}>
              <Text style={[styles.timerLabel, { color: p.ink2 }]}>
                {t.label || 'Timer'}
              </Text>
              <Pressable
                hitSlop={10}
                onPress={() => void cancelTimer(t.id)}
                accessibilityRole="button"
                accessibilityLabel="Cancel timer"
              >
                <GlyphX color={p.ink3} size={14} />
              </Pressable>
            </View>
            <Text style={[styles.bigTime, { color: p.ink }]}>
              {formatDuration(remaining)}
            </Text>
            <View style={[styles.track, { backgroundColor: p.surface2 }]}>
              <View
                style={[
                  styles.fill,
                  {
                    backgroundColor: t.state === 'paused' ? p.ink3 : p.live,
                    width: `${Math.max(1, Math.round(frac * 100))}%`,
                  },
                ]}
              />
            </View>
            <View style={styles.actions}>
              {t.state === 'running' ? (
                <Button
                  label="Pause"
                  kind="ghost"
                  onPress={() => void pauseTimer(t.id)}
                />
              ) : (
                <Button label="Resume" onPress={() => void resumeTimer(t.id)} />
              )}
            </View>
          </View>
        );
      })}
      {done.map(t => (
        <Row
          key={t.id}
          title={`${t.label || 'Timer'} · done`}
          subtitle={`${formatDuration(t.durationSeconds)} finished`}
          first
          last
          right={
            <Button
              label="Clear"
              kind="ghost"
              onPress={() => void cancelTimer(t.id)}
            />
          }
        />
      ))}

      <View
        style={[
          styles.card,
          { backgroundColor: p.surface, borderColor: p.line },
        ]}
      >
        <Label>new timer</Label>
        <View style={styles.chips}>
          {[1, 3, 5, 10, 15, 25, 45, 60].map(m => (
            <Chip
              key={m}
              label={m >= 60 ? `${m / 60} h` : `${m} min`}
              onPress={() => start(m)}
            />
          ))}
        </View>
        <View style={styles.inline}>
          <View style={{ flex: 1 }}>
            <Field
              label="Minutes"
              value={custom}
              placeholder="12"
              keyboardType="decimal-pad"
              onChangeText={setCustom}
            />
          </View>
          <View style={{ flex: 2 }}>
            <Field
              label="Label (optional)"
              value={label}
              placeholder="Pasta"
              onChangeText={setLabel}
            />
          </View>
        </View>
        {error ? <Text style={{ color: p.danger }}>{error}</Text> : null}
        <View style={styles.actions}>
          <Button
            label="Start"
            disabled={!(Number(custom) > 0)}
            onPress={() => {
              start(Number(custom));
              setCustom('');
            }}
          />
        </View>
      </View>
      <Text style={[styles.hint, { color: p.ink3 }]}>
        Or just say it: “timer for 12 minutes”, “pasta timer 9 minutes”.
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------

function StopwatchView({ now }: { now: number }): React.JSX.Element {
  const p = usePalette();
  const sw = useClockStore(s => s.stopwatch);
  const start = useClockStore(s => s.stopwatchStart);
  const stop = useClockStore(s => s.stopwatchStop);
  const lap = useClockStore(s => s.stopwatchLap);
  const reset = useClockStore(s => s.stopwatchReset);
  const elapsed = stopwatchElapsedMs(sw, now);

  return (
    <View style={{ gap: space(4) }}>
      <View
        style={[
          styles.card,
          {
            backgroundColor: p.surface,
            borderColor: sw.running ? p.live : p.line,
            alignItems: 'center',
          },
        ]}
      >
        <Text style={[styles.stopwatch, { color: p.ink }]}>
          {formatStopwatch(elapsed)}
        </Text>
        <View style={styles.actions}>
          {sw.running ? (
            <>
              <Button label="Lap" kind="ghost" onPress={lap} />
              <Button label="Stop" onPress={stop} />
            </>
          ) : (
            <>
              <Button
                label="Reset"
                kind="ghost"
                onPress={reset}
                disabled={elapsed === 0}
              />
              <Button
                label={elapsed === 0 ? 'Start' : 'Resume'}
                onPress={start}
              />
            </>
          )}
        </View>
      </View>
      {sw.laps.length > 0 ? (
        <View>
          {[...sw.laps].reverse().map((ms, i, arr) => {
            const idx = arr.length - i;
            const prev = sw.laps[idx - 2] ?? 0;
            return (
              <Row
                key={idx}
                title={`Lap ${idx}`}
                subtitle={`split ${formatStopwatch(ms - prev)}`}
                right={
                  <Text
                    style={{ color: p.ink2, fontVariant: ['tabular-nums'] }}
                  >
                    {formatStopwatch(ms)}
                  </Text>
                }
                first={i === 0}
                last={i === arr.length - 1}
                mono
              />
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  tabs: { paddingHorizontal: space(4), paddingBottom: space(2) },
  body: { padding: space(4), paddingBottom: space(12), gap: space(4) },
  card: {
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: space(4),
    gap: space(3),
  },
  bigTime: {
    fontSize: 44,
    fontWeight: '300',
    letterSpacing: -1,
    fontVariant: ['tabular-nums'],
  },
  stopwatch: {
    fontSize: 56,
    fontWeight: '200',
    letterSpacing: -1.5,
    fontVariant: ['tabular-nums'],
    paddingVertical: space(4),
  },
  steppers: { flexDirection: 'row', gap: space(3) },
  stepper: { flex: 1, alignItems: 'center', gap: space(1) },
  stepBtn: {
    width: '100%',
    height: 40,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepText: { fontSize: 22, fontWeight: '500' },
  stepLabel: { fontSize: 11, textTransform: 'uppercase', letterSpacing: 1 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space(2) },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: space(2) },
  inline: { flexDirection: 'row', gap: space(3) },
  rowRight: { flexDirection: 'row', alignItems: 'center', gap: space(3) },
  timerHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  timerLabel: {
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  track: { height: 4, borderRadius: 2, overflow: 'hidden' },
  fill: { height: 4, borderRadius: 2 },
  hint: { fontSize: 13, lineHeight: 18 },
});
