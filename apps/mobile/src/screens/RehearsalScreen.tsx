import React, { useCallback, useRef, useState } from 'react';
import { FlatList, Share, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { AgentLoop, type AgentEvent } from '@minimus/agent-core';
import { LocalAdapter } from '../services/LocalAdapter';
import { getToolRegistry } from '../tools';
import { useModelStore } from '../stores/modelStore';
import { loadMacros } from '../tools/macroTools';
import { diag } from '../services/diag';
import { composeRun } from '../services/intent';
import { acquireRun, releaseRun } from '../services/runLock';
import { verbFor } from '../services/humanize';
import { runSelfTests, type CheckResult } from '../services/selfTest';
import { runDeepChecks } from '../services/deepTest';
import { color, font, radius, space } from '../theme';
import { LiveDot } from '../components/LiveDot';

/**
 * Demo rehearsal — runs the storyboard from docs/DEMOS.md against the REAL
 * agent and the REAL tools on this phone, and reports pass/fail per beat.
 *
 * It exists because a demo you haven't run end-to-end on the actual device an
 * hour before showtime is a demo that fails on stage. Every result is also
 * written to the device console (idevicesyslog / adb logcat) with timings, so
 * a run can be inspected from a laptop without touching the phone.
 */

interface Beat {
  id: string;
  title: string;
  utterance: string;
  /** Tool that must be called for the beat to count as working. */
  expectTool: string;
  /** Beats that yank focus to another app — opt in explicitly. */
  stealsFocus?: boolean;
  note?: string;
}

const BEATS: Beat[] = [
  {
    id: 'private-remember',
    title: '1. Private context — store',
    utterance:
      "Remember that I'm on 20mg of Lexapro, my therapist is Dr. Okafor, and my appointment is Thursday at 4pm.",
    expectTool: 'remember',
  },
  {
    id: 'watchdog-arm',
    title: '2. Watchdog — arm it',
    utterance:
      'Check my battery now and remember it. Then in 3 minutes check it again and tell me if it dropped more than 2 percent.',
    expectTool: 'schedule_task',
    note: 'fires on its own ~3 min later',
  },
  {
    id: 'teach-macro',
    title: '3. Teach a verb',
    utterance:
      'New rule: when I say wind down, set the brightness to 20 percent, turn the flashlight off, and remind me to set my alarm.',
    expectTool: 'define_macro',
  },
  {
    id: 'run-macro',
    title: '3b. Say the verb',
    utterance: 'Wind down.',
    expectTool: 'run_macro',
  },
  {
    id: 'calendar-judgment',
    title: '4. Calendar judgment',
    utterance:
      "Look at tomorrow — find me 90 minutes for the gym that isn't before 10am and isn't straight after standup, and put it in.",
    expectTool: 'calendar_query',
    note: 'needs calendar permission + events tomorrow',
  },
  {
    id: 'private-recall',
    title: '1b. Private context — recall',
    utterance: 'What do I need to remember about Thursday?',
    expectTool: 'recall',
  },
  {
    id: 'flashlight',
    title: 'Bench: flashlight',
    utterance: 'turn on the flashlight',
    expectTool: 'flashlight',
  },
  {
    id: 'spotify',
    title: 'Bench: Spotify (opens Spotify)',
    utterance: 'Play Janice STFU on Spotify',
    expectTool: 'play_music',
    stealsFocus: true,
    note: 'leaves the app — come back to continue',
  },
];

type Status = 'idle' | 'running' | 'pass' | 'fail';

interface BeatResult {
  status: Status;
  detail?: string;
  seconds?: number;
  tools?: string[];
  /** Final answer text on FAIL — what the model claimed. */
  said?: string;
  /** Raw per-turn model output on FAIL (thinking stripped). */
  raw?: string[];
  /** Parse-retry reasons observed during the run. */
  retries?: string[];
}

const registry = getToolRegistry();

export default function RehearsalScreen({ onClose }: { onClose: () => void }): React.JSX.Element {
  const activeModelId = useModelStore((s) => s.activeModelId);
  const [results, setResults] = useState<Record<string, BeatResult>>({});
  const [busy, setBusy] = useState(false);
  const [includeFocus, setIncludeFocus] = useState(false);
  const [checks, setChecks] = useState<CheckResult[]>([]);
  const [checking, setChecking] = useState(false);
  const cancelled = useRef(false);
  const inFlight = useRef(false);

  // Deterministic checks first: they catch broken schemas, storage, routing and
  // native bridges in under a second, so a red beat later is about the MODEL
  // rather than about plumbing.
  const runChecks = useCallback(async (): Promise<CheckResult[]> => {
    setChecking(true);
    setChecks([]);
    const collected: CheckResult[] = [];
    const results = await runSelfTests((r) => {
      collected.push(r);
      setChecks([...collected]);
      diag(`CHECK ${r.ok ? '✅' : '❌'} ${r.name}: ${r.detail}`);
    });
    setChecking(false);
    return results;
  }, []);

  // Deep checks exercise every feature the demo beats never touch: voice
  // (a TTS to STT round trip, no microphone required), MCP, custom tools,
  // vision, notifications, calendar writes, web search, and the storage
  // round trips for memories, macros, scheduled tasks, sessions and settings.
  const runDeep = useCallback(async (): Promise<CheckResult[]> => {
    setChecking(true);
    const collected: CheckResult[] = [];
    const results = await runDeepChecks((r) => {
      collected.push(r);
      setChecks((prev) => [...prev.filter((p) => p.name !== r.name), r]);
      diag(`DEEP ${r.ok ? '✅' : '❌'} ${r.name}: ${r.detail}`);
    });
    setChecking(false);
    return results;
  }, []);

  const runBeat = useCallback(
    async (beat: Beat): Promise<boolean> => {
      // The phone decodes one generation at a time — a second tap while a beat
      // is running queues a starved run that fails as "got no tools".
      // inFlight guards double taps on this screen; acquireRun guards the
      // device — a scheduled task coming due must not generate on top of a
      // beat (services/runLock).
      if (inFlight.current || !acquireRun()) return false;
      inFlight.current = true;
      const started = Date.now();
      setResults((r) => ({ ...r, [beat.id]: { status: 'running' } }));
      diag(`REHEARSAL ▶ ${beat.id}: ${JSON.stringify(beat.utterance.slice(0, 80))}`);

      const macros = await loadMacros().catch(() => []);
      // The SHIPPING composition, same as the chat screen and the scheduled
      // runner (agent-core/routing.ts). Beats used to carry a hand-written
      // toolGroups list, which meant a green rehearsal could not tell you
      // whether the app exposes the right tools — it tested the list, not the
      // router.
      const { toolGroups, excludeTools, preamble } = composeRun(beat.utterance, {
        macroNames: macros.map((m) => m.name),
      });

      const toolsCalled: string[] = [];
      let finalText = '';
      let failure = '';
      // Raw model output per turn — the ONLY way to see a tool call the
      // parser rejected (the model then claims success in prose; the
      // "said:" line alone can't show what it actually emitted).
      let rawTurn = '';
      const rawTurns: string[] = [];
      const retryReasons: string[] = [];
      try {
        const events: AsyncGenerator<AgentEvent> = new AgentLoop().run(beat.utterance, {
          adapter: new LocalAdapter(activeModelId),
          tools: registry,
          toolGroups,
          excludeTools,
          preamble,
          approvals: async () => true,
        });
        for await (const ev of events) {
          if (ev.type === 'text_delta') rawTurn += ev.text;
          if (ev.type === 'turn_finished') {
            if (rawTurn.trim()) rawTurns.push(rawTurn);
            rawTurn = '';
          }
          if (ev.type === 'parse_retry') {
            retryReasons.push(ev.reason);
            diag(`REHEARSAL   · retry: ${ev.reason}`);
          }
          if (ev.type === 'tool_call_started') {
            toolsCalled.push(ev.call.name);
            diag(`REHEARSAL   · ${verbFor(ev.call)}`);
            // The humanized verb hides the arguments, and for schedule_task
            // the argument IS the behaviour: "+3" and "+3s" both satisfy a
            // check for "3" while meaning three minutes and three seconds.
            // Watched a scheduled task fire 1.5s after being armed with no
            // way to tell which had been asked for.
            if (ev.call.name === 'schedule_task') {
              diag(`REHEARSAL   · when=${JSON.stringify(ev.call.arguments['when'])}`);
            }
          }
          if (ev.type === 'tool_call_finished' && ev.isError) {
            failure = `${ev.call.name}: ${ev.result.slice(0, 120)}`;
          }
          if (ev.type === 'run_finished') {
            finalText = ev.finalText;
            if (ev.reason !== 'completed') failure = failure || `run ${ev.reason}`;
          }
        }
      } catch (err) {
        failure = err instanceof Error ? err.message : String(err);
      } finally {
        inFlight.current = false;
        releaseRun();
      }

      const seconds = Math.round((Date.now() - started) / 100) / 10;
      const called = toolsCalled.includes(beat.expectTool);
      const pass = called && !failure;
      const detail = pass
        ? finalText.slice(0, 100) || 'done'
        : failure || `expected ${beat.expectTool}, got ${toolsCalled.join(', ') || 'no tools'}`;
      const rawVisible = rawTurns
        .map((raw) => raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim())
        .filter(Boolean);
      setResults((r) => ({
        ...r,
        [beat.id]: {
          status: pass ? 'pass' : 'fail',
          detail,
          seconds,
          tools: toolsCalled,
          ...(pass ? {} : { said: finalText, raw: rawVisible }),
          ...(retryReasons.length > 0 ? { retries: retryReasons } : {}),
        },
      }));
      diag(
        `REHEARSAL ${pass ? '✅ PASS' : '❌ FAIL'} ${beat.id} in ${seconds}s tools=[${toolsCalled.join(
          ',',
        )}] ${pass ? '' : detail}`,
      );
      // On FAIL, what the model SAID is the diagnosis — a beat that answers
      // in text instead of scheduling is invisible without this.
      if (!pass && finalText) {
        diag(`REHEARSAL   ↳ said: ${JSON.stringify(finalText.slice(0, 200))}`);
      }
      // And what it EMITTED raw — a rejected tool call only shows up here.
      // Thinking is stripped: the call syntax is what matters, and syslog
      // lines have finite patience.
      if (!pass) {
        for (const [i, raw] of rawTurns.entries()) {
          const visible = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
          if (visible) diag(`REHEARSAL   ↳ raw[${i}]: ${JSON.stringify(visible.slice(0, 300))}`);
        }
      }
      return pass;
    },
    [activeModelId],
  );

  const runAll = useCallback(async () => {
    setBusy(true);
    cancelled.current = false;
    await runChecks();
    const beats = BEATS.filter((b) => includeFocus || !b.stealsFocus);
    diag(`REHEARSAL === start: ${beats.length} beats, model=${activeModelId} ===`);
    const startedAll = Date.now();
    let passed = 0;
    for (const beat of beats) {
      if (cancelled.current) break;
      if (await runBeat(beat)) passed += 1;
    }
    diag(
      `REHEARSAL === done: ${passed}/${beats.length} passed in ${Math.round(
        (Date.now() - startedAll) / 1000,
      )}s ===`,
    );
    setBusy(false);
  }, [includeFocus, runBeat, activeModelId, runChecks]);

  const passCount = Object.values(results).filter((r) => r.status === 'pass').length;
  const failCount = Object.values(results).filter((r) => r.status === 'fail').length;

  // Full-fidelity report through the share sheet — the phone can be
  // unplugged during a run (watchdog needs it) and syslog forensics die with
  // the cable; this is the offline path for the same evidence.
  const shareReport = useCallback(async () => {
    const lines: string[] = [
      `Minimus rehearsal report`,
      `model: ${activeModelId}`,
      `time: ${new Date().toISOString()}`,
      `tally: ${passCount} passed · ${failCount} failed`,
      '',
      `system checks: ${checks.filter((c) => c.ok).length}/${checks.length} passed`,
      ...checks.map((c) => `${c.ok ? '✅' : '❌'} ${c.name}: ${c.detail}`),
      '',
    ];
    for (const beat of BEATS) {
      const r = results[beat.id];
      if (!r || r.status === 'idle' || r.status === 'running') continue;
      lines.push(`${r.status === 'pass' ? '✅' : '❌'} ${beat.id} (${r.seconds ?? '?'}s)`);
      lines.push(`   utterance: "${beat.utterance}"`);
      lines.push(`   tools: [${(r.tools ?? []).join(', ')}]`);
      if (r.detail) lines.push(`   detail: ${r.detail}`);
      if (r.retries?.length) lines.push(`   retries: ${r.retries.join(' | ')}`);
      if (r.status === 'fail') {
        if (r.said) lines.push(`   said: ${JSON.stringify(r.said.slice(0, 400))}`);
        for (const [i, raw] of (r.raw ?? []).entries()) {
          lines.push(`   raw[${i}]: ${JSON.stringify(raw.slice(0, 500))}`);
        }
      }
      lines.push('');
    }
    await Share.share({ message: lines.join('\n') }).catch(() => undefined);
  }, [results, activeModelId, passCount, failCount, checks]);

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.title}>Rehearsal</Text>
        <TouchableOpacity onPress={onClose} hitSlop={12} disabled={busy}>
          <Text style={[styles.close, busy && styles.closeDisabled]}>Done</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.blurb}>
        Runs every demo beat against the real model and real tools on this phone. Results also go to
        the device console.
      </Text>

      <View style={styles.controls}>
        <TouchableOpacity
          style={[styles.runBtn, busy && styles.runBtnBusy]}
          onPress={() => (busy ? (cancelled.current = true) : void runAll())}
        >
          <Text style={styles.runBtnText}>{busy ? 'Stop' : 'Run all beats'}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.toggle}
          onPress={() => void runChecks()}
          disabled={busy || checking}
          accessibilityRole="button"
          accessibilityLabel="Run system checks"
        >
          <Text style={styles.toggleText} numberOfLines={1}>
            {checking ? 'checking…' : 'checks'}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.toggle}
          onPress={() => void runDeep()}
          disabled={busy || checking}
          accessibilityRole="button"
          accessibilityLabel="Run deep feature checks"
        >
          <Text style={styles.toggleText} numberOfLines={1}>
            deep
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.toggle, includeFocus && styles.toggleOn]}
          onPress={() => setIncludeFocus((v) => !v)}
          disabled={busy}
        >
          <Text
            style={[styles.toggleText, includeFocus && styles.toggleTextOn]}
            numberOfLines={1}
          >
            app-switching
          </Text>
        </TouchableOpacity>
      </View>

      {passCount + failCount > 0 ? (
        <View style={styles.tallyRow}>
          <Text style={styles.tally}>
            {passCount} passed · {failCount} failed
          </Text>
          <TouchableOpacity onPress={() => void shareReport()} hitSlop={10} disabled={busy}>
            <Text style={[styles.shareBtn, busy && styles.closeDisabled]}>share report</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      <FlatList
        data={BEATS}
        keyExtractor={(b) => b.id}
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          checks.length > 0 ? (
            <View style={styles.checksBlock}>
              <Text style={styles.checksLabel}>
                system checks · {checks.filter((c) => c.ok).length}/{checks.length}
              </Text>
              {checks.map((c) => (
                <View key={c.name} style={styles.checkRow}>
                  <Text style={styles.statusGlyph}>{c.ok ? '✅' : '❌'}</Text>
                  <View style={styles.checkMain}>
                    <Text style={styles.checkName}>{c.name}</Text>
                    <Text
                      style={[styles.checkDetail, !c.ok && styles.detailFail]}
                      numberOfLines={2}
                    >
                      {c.detail}
                    </Text>
                  </View>
                </View>
              ))}
            </View>
          ) : null
        }
        renderItem={({ item }) => {
          const r = results[item.id];
          return (
            <TouchableOpacity
              style={styles.row}
              disabled={busy}
              onPress={() => void runBeat(item)}
            >
              <View style={styles.rowHead}>
                <View style={styles.statusCol}>
                  {r?.status === 'running' ? (
                    <LiveDot />
                  ) : (
                    <Text style={styles.statusGlyph}>
                      {r?.status === 'pass' ? '✅' : r?.status === 'fail' ? '❌' : '○'}
                    </Text>
                  )}
                </View>
                <Text style={styles.rowTitle}>{item.title}</Text>
                {r?.seconds !== undefined ? (
                  <Text style={styles.rowTime}>{r.seconds}s</Text>
                ) : null}
              </View>
              <Text style={styles.utterance} numberOfLines={2}>
                “{item.utterance}”
              </Text>
              {r?.detail ? (
                <Text
                  style={[styles.detail, r.status === 'fail' && styles.detailFail]}
                  numberOfLines={3}
                >
                  {r.detail}
                </Text>
              ) : item.note ? (
                <Text style={styles.note}>{item.note}</Text>
              ) : null}
            </TouchableOpacity>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg0 },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: space(4),
    paddingVertical: space(3),
  },
  title: { color: color.text, fontSize: 20, fontWeight: '800' },
  close: { color: color.amber, fontSize: 15, fontWeight: '600' },
  closeDisabled: { color: color.faint },
  blurb: {
    color: color.dim,
    fontSize: 13,
    lineHeight: 19,
    paddingHorizontal: space(4),
    marginBottom: space(3),
  },
  controls: { flexDirection: 'row', gap: space(2), paddingHorizontal: space(4), alignItems: 'center' },
  runBtn: {
    backgroundColor: color.amber,
    borderRadius: radius.chip,
    paddingHorizontal: space(4),
    paddingVertical: space(2.5),
  },
  runBtnBusy: { backgroundColor: color.bg2, borderWidth: 1, borderColor: color.danger },
  runBtnText: { color: color.bg0, fontWeight: '700', fontSize: 14 },
  toggle: {
    flex: 1,
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: radius.chip,
    paddingHorizontal: space(3),
    paddingVertical: space(2.5),
  },
  toggleOn: { borderColor: color.amberDeep },
  toggleText: { color: color.faint, fontSize: 11, fontFamily: font.mono },
  toggleTextOn: { color: color.amber },
  tallyRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: space(4),
    paddingTop: space(3),
  },
  tally: {
    color: color.dim,
    fontFamily: font.mono,
    fontSize: 12,
  },
  shareBtn: { color: color.cyan, fontFamily: font.mono, fontSize: 12 },
  list: { padding: space(4), gap: space(2) },
  checksBlock: {
    backgroundColor: color.bg1,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: color.line,
    padding: space(3),
    gap: space(2),
    marginBottom: space(2),
  },
  checksLabel: { color: color.amber, fontSize: 11, fontFamily: font.mono, letterSpacing: 1 },
  checkRow: { flexDirection: 'row', alignItems: 'flex-start', gap: space(2) },
  checkMain: { flex: 1, gap: space(1) },
  checkName: { color: color.text, fontSize: 13, fontWeight: '600' },
  checkDetail: { color: color.dim, fontSize: 11, fontFamily: font.mono, lineHeight: 15 },
  row: {
    backgroundColor: color.bg1,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: color.line,
    padding: space(3.5),
    gap: space(1.5),
  },
  rowHead: { flexDirection: 'row', alignItems: 'center', gap: space(2) },
  statusCol: { width: 18, alignItems: 'center' },
  statusGlyph: { fontSize: 13, color: color.faint },
  rowTitle: { color: color.text, fontSize: 14, fontWeight: '600', flex: 1 },
  rowTime: { color: color.cyan, fontFamily: font.mono, fontSize: 12 },
  utterance: { color: color.dim, fontSize: 12, lineHeight: 17, fontStyle: 'italic' },
  detail: { color: color.ok, fontSize: 12, fontFamily: font.mono, lineHeight: 17 },
  detailFail: { color: color.danger },
  note: { color: color.faint, fontSize: 11, fontFamily: font.mono },
});
