import React, { useCallback, useRef, useState } from 'react';
import { FlatList, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { AgentLoop, type AgentEvent } from '@minimus/agent-core';
import { LocalAdapter } from '../services/LocalAdapter';
import { getToolRegistry } from '../tools';
import { useModelStore } from '../stores/modelStore';
import { loadMacros } from '../tools/macroTools';
import { diag } from '../services/diag';
import { verbFor } from '../services/humanize';
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
}

const registry = getToolRegistry();

export default function RehearsalScreen({ onClose }: { onClose: () => void }): React.JSX.Element {
  const activeModelId = useModelStore((s) => s.activeModelId);
  const [results, setResults] = useState<Record<string, BeatResult>>({});
  const [busy, setBusy] = useState(false);
  const [includeFocus, setIncludeFocus] = useState(false);
  const cancelled = useRef(false);

  const runBeat = useCallback(
    async (beat: Beat): Promise<boolean> => {
      const started = Date.now();
      setResults((r) => ({ ...r, [beat.id]: { status: 'running' } }));
      diag(`REHEARSAL ▶ ${beat.id}: ${JSON.stringify(beat.utterance.slice(0, 80))}`);

      const macros = await loadMacros().catch(() => []);
      const preamble = [
        'You are Minimus, running entirely on this phone. You get things DONE using tools, then confirm briefly.',
        macros.length > 0
          ? `Phrases the user has taught you (run these with run_macro): ${macros
              .map((m) => `"${m.name}"`)
              .join(', ')}. If the user says one of them, call run_macro with that name.`
          : '',
      ]
        .filter(Boolean)
        .join('\n');

      const toolsCalled: string[] = [];
      let finalText = '';
      let failure = '';
      try {
        const events: AsyncGenerator<AgentEvent> = new AgentLoop().run(beat.utterance, {
          adapter: new LocalAdapter(activeModelId),
          tools: registry,
          preamble,
          approvals: async () => true,
        });
        for await (const ev of events) {
          if (ev.type === 'tool_call_started') {
            toolsCalled.push(ev.call.name);
            diag(`REHEARSAL   · ${verbFor(ev.call)}`);
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
      }

      const seconds = Math.round((Date.now() - started) / 100) / 10;
      const called = toolsCalled.includes(beat.expectTool);
      const pass = called && !failure;
      const detail = pass
        ? finalText.slice(0, 100) || 'done'
        : failure || `expected ${beat.expectTool}, got ${toolsCalled.join(', ') || 'no tools'}`;
      setResults((r) => ({
        ...r,
        [beat.id]: { status: pass ? 'pass' : 'fail', detail, seconds, tools: toolsCalled },
      }));
      diag(
        `REHEARSAL ${pass ? '✅ PASS' : '❌ FAIL'} ${beat.id} in ${seconds}s tools=[${toolsCalled.join(
          ',',
        )}] ${pass ? '' : detail}`,
      );
      return pass;
    },
    [activeModelId],
  );

  const runAll = useCallback(async () => {
    setBusy(true);
    cancelled.current = false;
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
  }, [includeFocus, runBeat, activeModelId]);

  const passCount = Object.values(results).filter((r) => r.status === 'pass').length;
  const failCount = Object.values(results).filter((r) => r.status === 'fail').length;

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
          style={[styles.toggle, includeFocus && styles.toggleOn]}
          onPress={() => setIncludeFocus((v) => !v)}
          disabled={busy}
        >
          <Text style={[styles.toggleText, includeFocus && styles.toggleTextOn]}>
            include app-switching beats
          </Text>
        </TouchableOpacity>
      </View>

      {passCount + failCount > 0 ? (
        <Text style={styles.tally}>
          {passCount} passed · {failCount} failed
        </Text>
      ) : null}

      <FlatList
        data={BEATS}
        keyExtractor={(b) => b.id}
        contentContainerStyle={styles.list}
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
  tally: {
    color: color.dim,
    fontFamily: font.mono,
    fontSize: 12,
    paddingHorizontal: space(4),
    paddingTop: space(3),
  },
  list: { padding: space(4), gap: space(2) },
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
