import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { addMemory, listMemories, removeMemory, type Memory } from '../tools/memoryTools';
import { loadMacros, removeMacro, type Macro } from '../tools/macroTools';
import { scheduler, type ScheduledTask } from '../services/scheduler';
import { verbFor } from '../services/humanize';
import { font, radius, space, usePalette } from '../theme';
import { Button, Field, Header, Label, Screen } from '../ui/primitives';
import { GlyphX } from '../ui/glyphs';

/**
 * Memory — everything the agent knows about you, in the open and editable:
 * facts it remembered, phrases you taught it (with the steps they replay),
 * and the runs it has scheduled for later. Nothing here is hidden state.
 */
export default function MemoryScreen({ onClose }: { onClose: () => void }): React.JSX.Element {
  const p = usePalette();
  const [memories, setMemories] = useState<Memory[]>([]);
  const [macros, setMacros] = useState<Macro[]>([]);
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [draft, setDraft] = useState('');
  const [openMacro, setOpenMacro] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void listMemories().then(setMemories).catch(() => setMemories([]));
    void loadMacros().then(setMacros).catch(() => setMacros([]));
    void scheduler.listPending().then(setTasks).catch(() => setTasks([]));
  }, []);
  useEffect(refresh, [refresh]);
  useEffect(() => scheduler.onTaskEvent(refresh), [refresh]);

  const due = (ms: number) => {
    const mins = Math.round((ms - Date.now()) / 60_000);
    if (mins < 1) return 'due now';
    if (mins < 60) return `in ${mins} min`;
    const d = new Date(ms);
    return `at ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${d.toDateString() !== new Date().toDateString() ? ` ${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}` : ''}`;
  };

  return (
    <Screen>
      <Header title="Memory" eyebrow="stays on this phone" onClose={onClose} />
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <Section title="Remembered" count={memories.length} hint="Facts you told it. It reads these when you ask.">
          {memories.map((m) => (
            <Line key={m.id} text={m.text} meta={m.savedAt} onDelete={() => void removeMemory(m.id).then(refresh)} />
          ))}
          <View style={styles.addRow}>
            <Field
              placeholder="Add something it should know…"
              value={draft}
              onChangeText={setDraft}
              style={{ flex: 1 }}
              onSubmitEditing={() => {
                if (draft.trim()) void addMemory(draft).then(() => {
                  setDraft('');
                  refresh();
                });
              }}
              returnKeyType="done"
            />
            <Button
              label="Add"
              small
              disabled={!draft.trim()}
              onPress={() =>
                void addMemory(draft).then(() => {
                  setDraft('');
                  refresh();
                })
              }
            />
          </View>
        </Section>

        <Section title="Taught phrases" count={macros.length} hint='Say one and it replays the steps instantly. Teach one in chat: "New rule: when I say…"'>
          {macros.length === 0 ? <Empty text="No phrases yet." /> : null}
          {macros.map((m) => {
            const open = openMacro === m.name;
            return (
              <Pressable key={m.name} onPress={() => setOpenMacro(open ? null : m.name)} style={[styles.macro, { borderColor: p.line, backgroundColor: p.surface }]}>
                <View style={styles.macroHead}>
                  <Text style={[styles.macroName, { color: p.ink }]}>“{m.name}”</Text>
                  <Text style={[styles.meta, { color: p.ink3 }]}>
                    {m.steps.length} step{m.steps.length === 1 ? '' : 's'}
                  </Text>
                  <Pressable hitSlop={12} onPress={() => void removeMacro(m.name).then(refresh)} accessibilityLabel="Forget phrase">
                    <GlyphX color={p.ink3} size={12} />
                  </Pressable>
                </View>
                {open
                  ? m.steps.map((s, i) => (
                      <Text key={i} style={[styles.step, { color: p.ink2 }]}>
                        {i + 1}. {verbFor({ id: 'x', name: s.tool, arguments: s.arguments })}
                      </Text>
                    ))
                  : null}
              </Pressable>
            );
          })}
        </Section>

        <Section title="Scheduled" count={tasks.length} hint="Runs it will do later, on its own. It needs the app open at the time.">
          {tasks.length === 0 ? <Empty text="Nothing scheduled." /> : null}
          {tasks.map((t) => (
            <Line key={t.id} text={t.instruction} meta={due(t.dueAtMs)} onDelete={() => void scheduler.cancel(t.id).then(refresh)} accent />
          ))}
        </Section>
      </ScrollView>
    </Screen>
  );
}

function Section({ title, count, hint, children }: { title: string; count: number; hint: string; children: React.ReactNode }): React.JSX.Element {
  const p = usePalette();
  return (
    <View style={styles.section}>
      <View style={styles.sectionHead}>
        <Text style={[styles.sectionTitle, { color: p.ink }]}>{title}</Text>
        <Label>{count}</Label>
      </View>
      <Text style={[styles.hint, { color: p.ink3 }]}>{hint}</Text>
      <View style={{ gap: space(2) }}>{children}</View>
    </View>
  );
}

function Line({ text, meta, onDelete, accent }: { text: string; meta: string; onDelete: () => void; accent?: boolean }): React.JSX.Element {
  const p = usePalette();
  return (
    <View style={[styles.line, { backgroundColor: p.surface, borderColor: accent ? p.accent : p.line }]}>
      <View style={{ flex: 1, gap: 3 }}>
        <Text style={[styles.lineText, { color: p.ink }]}>{text}</Text>
        <Text style={[styles.meta, { color: accent ? p.accent : p.ink3 }]}>{meta}</Text>
      </View>
      <Pressable hitSlop={12} onPress={onDelete} accessibilityRole="button" accessibilityLabel="Delete">
        <GlyphX color={p.ink3} size={12} />
      </Pressable>
    </View>
  );
}

function Empty({ text }: { text: string }): React.JSX.Element {
  const p = usePalette();
  return <Text style={[styles.empty, { color: p.ink3 }]}>{text}</Text>;
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: space(4), paddingBottom: space(12), gap: space(7) },
  section: { gap: space(2) },
  sectionHead: { flexDirection: 'row', alignItems: 'baseline', gap: space(2) },
  sectionTitle: { fontSize: 18, fontWeight: '700', letterSpacing: -0.3 },
  hint: { fontSize: 12, lineHeight: 17, marginBottom: space(1) },
  line: { flexDirection: 'row', alignItems: 'center', gap: space(3), borderWidth: 1, borderRadius: radius.md, paddingHorizontal: space(3.5), paddingVertical: space(3) },
  lineText: { fontSize: 15, lineHeight: 20 },
  meta: { fontSize: 11, fontFamily: font.mono },
  addRow: { flexDirection: 'row', gap: space(2), alignItems: 'center', marginTop: space(1) },
  macro: { borderWidth: 1, borderRadius: radius.md, paddingHorizontal: space(3.5), paddingVertical: space(3), gap: space(1.5) },
  macroHead: { flexDirection: 'row', alignItems: 'center', gap: space(3) },
  macroName: { flex: 1, fontSize: 15, fontWeight: '600' },
  step: { fontSize: 13, lineHeight: 18, fontFamily: font.mono },
  empty: { fontSize: 13, fontStyle: 'italic' },
});
