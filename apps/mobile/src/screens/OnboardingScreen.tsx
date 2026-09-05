import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import DeviceInfo from 'react-native-device-info';
import {
  AGENT_MODELS,
  DEFAULT_MODEL_ID,
  downloadModel,
  findModel,
  formatBytes,
  isDownloaded,
  type ModelSpec,
} from '../services/models';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useModelStore } from '../stores/modelStore';
import { useSettingsStore } from '../stores/settingsStore';
import { setDailyBrief } from '../services/brief';
import { registerQaHandler } from '../services/qaBridge';
import { elevation, font, radius, space, usePalette } from '../theme';
import { Button, Label } from '../ui/primitives';
import { Core } from '../ui/Core';

/**
 * First run. Four beats: what this is, which brain to start with (the
 * trade-off in one line each), the download with a speed and time left, and
 * one question — do you want a morning brief, and when. Every later launch
 * skips straight through when the model is present and the question has
 * been answered once.
 */

type Phase =
  'checking' | 'choose' | 'downloading' | 'loading' | 'brief' | 'error';

const BRIEF_ASKED_KEY = 'minimus.onboarding.briefAsked';
const BRIEF_TIMES = ['07:00', '07:30', '08:00', '09:00'];

export default function OnboardingScreen({
  onReady,
}: {
  onReady: () => void;
}): React.JSX.Element {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const activeModelId = useModelStore(s => s.activeModelId);
  const engineState = useModelStore(s => s.engineState);
  const [phase, setPhase] = useState<Phase>('checking');
  const [choice, setChoice] = useState<string>(activeModelId);
  const [percent, setPercent] = useState(0);
  const [rate, setRate] = useState('');
  const [eta, setEta] = useState('');
  const [error, setError] = useState('');
  const [ram, setRam] = useState(0);
  const abort = useRef<AbortController | null>(null);

  const [briefTime, setBriefTime] = useState('08:00');
  const [briefBusy, setBriefBusy] = useState(false);

  const finishBrief = useCallback(
    async (time: string) => {
      setBriefBusy(true);
      try {
        await setDailyBrief(time);
      } catch {
        /* the brief can be set later in Settings */
      }
      AsyncStorage.setItem(BRIEF_ASKED_KEY, '1').catch(() => undefined);
      onReady();
    },
    [onReady],
  );

  // Laptop QA cannot tap: let it answer the brief question.
  useEffect(
    () =>
      registerQaHandler('onboardBrief', async args => {
        await finishBrief(typeof args['time'] === 'string' ? args['time'] : '');
        return { ok: true };
      }),
    [finishBrief],
  );

  const load = useCallback(async () => {
    setPhase('loading');
    try {
      await useModelStore.getState().ensureLoaded();
      const asked = await AsyncStorage.getItem(BRIEF_ASKED_KEY).catch(
        () => null,
      );
      if (asked || useSettingsStore.getState().briefTime) onReady();
      else setPhase('brief');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('error');
    }
  }, [onReady]);

  useEffect(() => {
    void (async () => {
      try {
        setRam(await DeviceInfo.getTotalMemory());
        const target =
          (await findModel(activeModelId)) ??
          AGENT_MODELS.find(m => m.id === DEFAULT_MODEL_ID)!;
        if (await isDownloaded(target)) await load();
        else setPhase('choose');
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setPhase('error');
      }
    })();
  }, [activeModelId, load]);

  const download = useCallback(async () => {
    const spec = AGENT_MODELS.find(m => m.id === choice);
    if (!spec) return;
    useModelStore.getState().setActiveModel(spec.id);
    setPhase('downloading');
    setPercent(0);
    abort.current = new AbortController();
    try {
      await downloadModel(
        spec,
        pr => {
          setPercent(Math.round(pr.fraction * 100));
          setRate(
            pr.bytesPerSecond > 0 ? `${formatBytes(pr.bytesPerSecond)}/s` : '',
          );
          const left =
            pr.bytesPerSecond > 0
              ? (pr.totalBytes - pr.bytesWritten) / pr.bytesPerSecond
              : 0;
          setEta(
            left > 0
              ? left > 90
                ? `${Math.ceil(left / 60)} min left`
                : `${Math.ceil(left)} s left`
              : '',
          );
        },
        abort.current.signal,
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase(abort.current?.signal.aborted ? 'choose' : 'error');
    }
  }, [choice, load]);

  const choices: ModelSpec[] = AGENT_MODELS.filter(
    m => !m.minRamBytes || !ram || ram >= m.minRamBytes,
  ).filter(m => m.tier !== 'deep');
  const chosen = AGENT_MODELS.find(m => m.id === choice) ?? AGENT_MODELS[0]!;
  const loadPercent =
    engineState.status === 'loading' ? Math.round(engineState.progress) : 0;

  return (
    <View
      style={[
        styles.root,
        {
          backgroundColor: p.bg,
          paddingTop: insets.top + space(8),
          paddingBottom: insets.bottom + space(6),
        },
      ]}
    >
      <View style={styles.hero}>
        <Core
          state={
            phase === 'loading'
              ? 'thinking'
              : phase === 'downloading'
                ? 'acting'
                : 'idle'
          }
          size={56}
        />
        <Text style={[styles.wordmark, { color: p.ink }]}>minimus</Text>
        <Text style={[styles.tag, { color: p.ink2 }]}>
          A small agent that lives in your phone. It reads your calendar,
          remembers what you tell it, learns your phrases and does things on
          your behalf. Nothing leaves the device.
        </Text>
      </View>

      {phase === 'checking' ? (
        <Label style={{ textAlign: 'center' }}>checking…</Label>
      ) : null}

      {phase === 'choose' ? (
        <ScrollView contentContainerStyle={styles.choose}>
          <Label>pick a brain · you can switch any time</Label>
          {choices.map(m => {
            const on = m.id === choice;
            return (
              <Pressable
                key={m.id}
                onPress={() => setChoice(m.id)}
                style={[
                  styles.card,
                  {
                    backgroundColor: p.surface,
                    borderColor: on ? p.ink : p.line,
                  },
                  elevation(p, 1),
                ]}
              >
                <View style={styles.cardHead}>
                  <Text style={[styles.cardName, { color: p.ink }]}>
                    {m.name}
                  </Text>
                  <Label>{formatBytes(m.sizeBytes)}</Label>
                </View>
                <Text style={[styles.cardTag, { color: p.ink2 }]}>
                  {m.tagline}
                </Text>
                {m.id === DEFAULT_MODEL_ID ? (
                  <Label tone="accent">recommended</Label>
                ) : null}
              </Pressable>
            );
          })}
          <Button
            label={`Download ${chosen.name} · ${formatBytes(chosen.sizeBytes)}`}
            onPress={() => void download()}
            style={{ marginTop: space(3) }}
          />
          <Text style={[styles.fine, { color: p.ink3 }]}>
            One-time download over Wi-Fi. The model is stored on this phone and
            never phones home.
          </Text>
        </ScrollView>
      ) : null}

      {phase === 'downloading' ? (
        <View style={styles.progressBlock}>
          <View style={[styles.track, { backgroundColor: p.surface2 }]}>
            <View
              style={[
                styles.fill,
                { width: `${percent}%`, backgroundColor: p.ink },
              ]}
            />
          </View>
          <View style={styles.progressRow}>
            <Text style={[styles.big, { color: p.ink }]}>{percent}%</Text>
            <Text style={[styles.mono, { color: p.ink3 }]}>
              {rate}
              {eta ? ` · ${eta}` : ''}
            </Text>
          </View>
          <Text style={[styles.fine, { color: p.ink2 }]}>
            Downloading {chosen.name}. Keep the app open.
          </Text>
          <Button
            label="Cancel"
            kind="ghost"
            small
            onPress={() => abort.current?.abort()}
            style={{ alignSelf: 'center' }}
          />
        </View>
      ) : null}

      {phase === 'loading' ? (
        <View style={styles.progressBlock}>
          <View style={[styles.track, { backgroundColor: p.surface2 }]}>
            <View
              style={[
                styles.fill,
                { width: `${loadPercent}%`, backgroundColor: p.live },
              ]}
            />
          </View>
          <Text style={[styles.fine, { color: p.ink2 }]}>
            Loading onto the GPU… {loadPercent}%
          </Text>
        </View>
      ) : null}

      {phase === 'brief' ? (
        <ScrollView contentContainerStyle={styles.choose}>
          <Label>one question · you can change it in settings</Label>
          <View
            style={[
              styles.card,
              { backgroundColor: p.surface, borderColor: p.line },
              elevation(p, 1),
            ]}
          >
            <Text style={[styles.cardName, { color: p.ink }]}>
              Want a morning brief?
            </Text>
            <Text style={[styles.cardTag, { color: p.ink2 }]}>
              Every day at the time you pick, Minimus gathers your calendar,
              reminders and alarms and tells you about the day in a few
              sentences. It runs on the phone; a notification brings you back if
              the app is closed.
            </Text>
            <View style={styles.times}>
              {BRIEF_TIMES.map(t => {
                const on = t === briefTime;
                const [h, m] = t.split(':').map(Number);
                const d = new Date();
                d.setHours(h!, m!, 0, 0);
                return (
                  <Pressable
                    key={t}
                    onPress={() => setBriefTime(t)}
                    style={[
                      styles.time,
                      {
                        backgroundColor: on ? p.ink : p.surface2,
                        borderColor: on ? p.ink : p.line,
                      },
                    ]}
                    accessibilityRole="button"
                    accessibilityState={{ selected: on }}
                  >
                    <Text
                      style={[styles.timeText, { color: on ? p.bg : p.ink }]}
                    >
                      {d.toLocaleTimeString([], {
                        hour: 'numeric',
                        minute: '2-digit',
                      })}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
          <Button
            label={`Yes, brief me at ${briefLabel(briefTime)}`}
            busy={briefBusy}
            onPress={() => void finishBrief(briefTime)}
            style={{ marginTop: space(3) }}
          />
          <Button
            label="Not now"
            kind="ghost"
            small
            onPress={() => void finishBrief('')}
            style={{ alignSelf: 'center' }}
          />
        </ScrollView>
      ) : null}

      {phase === 'error' ? (
        <View style={styles.progressBlock}>
          <Text style={[styles.error, { color: p.danger }]}>{error}</Text>
          <Button
            label="Try again"
            onPress={() => setPhase('choose')}
            style={{ alignSelf: 'center' }}
          />
        </View>
      ) : null}
    </View>
  );
}

function briefLabel(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date();
  d.setHours(h ?? 8, m ?? 0, 0, 0);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingHorizontal: space(6), gap: space(6) },
  hero: { alignItems: 'center', gap: space(3), paddingHorizontal: space(2) },
  wordmark: {
    fontSize: 40,
    fontWeight: '800',
    letterSpacing: -1.6,
    marginTop: space(2),
  },
  tag: {
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
    letterSpacing: -0.2,
  },
  choose: { gap: space(3), paddingBottom: space(6) },
  card: {
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: space(4),
    gap: space(1.5),
  },
  cardHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
  },
  cardName: { fontSize: 17, fontWeight: '700', letterSpacing: -0.3 },
  cardTag: { fontSize: 13, lineHeight: 18 },
  fine: { fontSize: 12, lineHeight: 17, textAlign: 'center' },
  times: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space(2),
    marginTop: space(2),
  },
  time: {
    paddingHorizontal: space(3),
    paddingVertical: space(2),
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  timeText: { fontSize: 14, fontWeight: '600', fontVariant: ['tabular-nums'] },
  progressBlock: { gap: space(3) },
  track: { height: 6, borderRadius: 3, overflow: 'hidden' },
  fill: { height: 6 },
  progressRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
  },
  big: {
    fontSize: 34,
    fontWeight: '800',
    letterSpacing: -1,
    fontVariant: ['tabular-nums'],
  },
  mono: { fontFamily: font.mono, fontSize: 12 },
  error: { fontSize: 13, textAlign: 'center', fontFamily: font.mono },
});
