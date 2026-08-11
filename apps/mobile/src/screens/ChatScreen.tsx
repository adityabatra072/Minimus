import React, { useCallback, useRef, useState } from 'react';
import {
  Animated,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { AgentLoop, type AgentEvent, type ToolCall } from '@minimus/agent-core';
import { LocalAdapter } from '../services/LocalAdapter';
import { buildToolRegistry } from '../tools';
import { useModelStore } from '../stores/modelStore';
import { verbFor, resultFor } from '../services/humanize';
import { overlay } from '../services/overlay';
import { ActionRail, type Operation } from '../components/ActionRail';
import { AgentText } from '../components/AgentText';
import { ApprovalCard } from '../components/ApprovalCard';
import { Composer } from '../components/Composer';
import { LiveDot } from '../components/LiveDot';
import { color, font, space } from '../theme';

/**
 * E.V conversation surface. The stream of raw model tokens NEVER renders —
 * the UI shows: quiet user pills, the action rail (live operations), a
 * "working" shimmer while the model runs, and the parsed answer typeset
 * plainly once each turn resolves. Tool syntax is invisible by construction.
 */

type Item =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'agent'; id: string; text: string }
  | { kind: 'rail'; id: string; ops: Operation[] }
  | {
      kind: 'approval';
      id: string;
      title: string;
      detail: string;
      resolve: (ok: boolean) => void;
      resolved?: 'yes' | 'no';
    };

// Seeded with time so Fast Refresh (which resets module state) can never
// mint ids that collide with items already in React state.
let idCounter = 0;
const idSeed = Date.now().toString(36);
const nextId = () => `i${idSeed}_${++idCounter}`;

const registry = buildToolRegistry();

const SUGGESTIONS = [
  'Turn on the flashlight',
  'Set a timer for 5 minutes',
  "What's Drake's latest song?",
  'How much battery do I have?',
];

function approvalSummary(call: ToolCall): { title: string; detail: string } {
  const a = call.arguments;
  switch (call.name) {
    case 'send_email':
      return {
        title: `Email ${String(a['to'] ?? '')}`,
        detail: `${a['subject'] ? `${String(a['subject'])} — ` : ''}${String(a['body'] ?? '')}`,
      };
    case 'send_sms':
      return { title: `Text ${String(a['to'] ?? '')}`, detail: String(a['body'] ?? '') };
    case 'make_call':
      return { title: `Call ${String(a['to'] ?? '')}`, detail: '' };
    default:
      return { title: verbFor(call), detail: '' };
  }
}

export default function ChatScreen({
  onOpenModels,
}: {
  onOpenModels?: () => void;
}): React.JSX.Element {
  const activeModelId = useModelStore((s) => s.activeModelId);
  const [items, setItems] = useState<Item[]>([]);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [working, setWorking] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<FlatList<Item>>(null);

  const scrollDown = () =>
    requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));

  const run = useCallback(
    async (prompt: string) => {
      if (!prompt.trim() || running) return;
      setInput('');
      setRunning(true);
      setWorking(true);
      const abort = new AbortController();
      abortRef.current = abort;

      setItems((prev) => [...prev, { kind: 'user', id: nextId(), text: prompt.trim() }]);
      scrollDown();

      const adapter = new LocalAdapter(activeModelId);
      const loop = new AgentLoop();

      let railId: string | null = null;
      let saidAnything = false;
      let lastOpSummary = '';

      const upsertRail = (mutate: (ops: Operation[]) => Operation[]) => {
        setItems((prev) => {
          if (railId === null) {
            railId = nextId();
            return [...prev, { kind: 'rail', id: railId, ops: mutate([]) }];
          }
          return prev.map((it) =>
            it.id === railId && it.kind === 'rail' ? { ...it, ops: mutate(it.ops) } : it,
          );
        });
        scrollDown();
      };

      const askApproval = (call: ToolCall): Promise<boolean> =>
        new Promise((resolve) => {
          const { title, detail } = approvalSummary(call);
          const id = nextId();
          setItems((prev) => [
            ...prev,
            {
              kind: 'approval',
              id,
              title,
              detail,
              resolve: (ok: boolean) => {
                setItems((p) =>
                  p.map((it) =>
                    it.id === id && it.kind === 'approval'
                      ? { ...it, resolved: ok ? 'yes' : 'no' }
                      : it,
                  ),
                );
                resolve(ok);
              },
            },
          ]);
          scrollDown();
        });

      try {
        const events = loop.run(prompt.trim(), {
          adapter,
          tools: registry,
          approvals: (req) => askApproval(req.call),
          signal: abort.signal,
        });
        for await (const ev of events) {
          handle(ev);
        }
      } catch (err) {
        setItems((prev) => [
          ...prev,
          {
            kind: 'agent',
            id: nextId(),
            text: `Something went wrong: ${err instanceof Error ? err.message : String(err)}`,
          },
        ]);
      } finally {
        setRunning(false);
        setWorking(false);
        abortRef.current = null;
        scrollDown();
      }

      function handle(ev: AgentEvent) {
        switch (ev.type) {
          case 'turn_started':
            setWorking(true);
            break;
          case 'assistant_turn':
            setWorking(false);
            console.log(
              `[minimus] assistant_turn calls=${ev.toolCallCount} text=${JSON.stringify(ev.text.slice(0, 120))}`,
            );
            // Prose from a tool-calling turn is usually preamble ("Let me
            // check…") — show it only when it's the final answer-ish turn or
            // meaningfully long.
            if (ev.text && (ev.toolCallCount === 0 || ev.text.length > 80)) {
              saidAnything = true;
              setItems((prev) => [...prev, { kind: 'agent', id: nextId(), text: ev.text }]);
              scrollDown();
            }
            break;
          case 'tool_call_started':
            upsertRail((ops) => [
              ...ops,
              { id: ev.call.id, verb: verbFor(ev.call), status: 'running' },
            ]);
            setWorking(false);
            break;
          case 'tool_call_finished': {
            const summary = resultFor(ev.call, ev.result, ev.isError);
            if (!ev.isError) lastOpSummary = summary;
            upsertRail((ops) => {
              const existing = ops.find((o) => o.id === ev.call.id);
              const done: Operation = {
                id: ev.call.id,
                verb: verbFor(ev.call),
                status: ev.isError ? 'error' : 'ok',
                result: summary,
              };
              return existing
                ? ops.map((o) => (o.id === ev.call.id ? done : o))
                : [...ops, done];
            });
            setWorking(true);
            break;
          }
          case 'approval_resolved':
            if (!ev.approved) {
              upsertRail((ops) => [
                ...ops,
                { id: ev.call.id, verb: verbFor(ev.call), status: 'denied', result: 'Skipped' },
              ]);
            }
            break;
          case 'run_finished':
            if (ev.reason === 'completed' && !saidAnything && lastOpSummary) {
              // The model acted but never spoke — close the loop honestly
              // with the last operation's result.
              setItems((prev) => [
                ...prev,
                { kind: 'agent', id: nextId(), text: `Done — ${lastOpSummary.toLowerCase()}.` },
              ]);
            }
            if (ev.reason === 'max_turns') {
              setItems((prev) => [
                ...prev,
                {
                  kind: 'agent',
                  id: nextId(),
                  text: 'I ran out of steps before finishing that — try breaking it into smaller asks.',
                },
              ]);
            } else if (ev.reason === 'error' && ev.error) {
              setItems((prev) => [
                ...prev,
                { kind: 'agent', id: nextId(), text: `I hit a problem: ${ev.error}` },
              ]);
            }
            break;
          default:
            break;
        }
      }
    },
    [running, activeModelId],
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Header onOpenModels={onOpenModels} />
      {items.length === 0 ? (
        <EmptyState onPick={(s) => void run(s)} />
      ) : (
        <FlatList
          ref={listRef}
          style={styles.list}
          data={items}
          keyExtractor={(it) => it.id}
          renderItem={({ item }) => <ItemView item={item} />}
          contentContainerStyle={styles.listContent}
          ListFooterComponent={working ? <WorkingRow /> : null}
        />
      )}
      <Composer
        value={input}
        onChange={setInput}
        onSend={() => void run(input)}
        onStop={stop}
        running={running}
      />
    </KeyboardAvoidingView>
  );
}

function Header({ onOpenModels }: { onOpenModels?: () => void }): React.JSX.Element {
  const activeModelId = useModelStore((s) => s.activeModelId);
  const modelLabel = activeModelId.replace(/-(ud-)?q\d.*$/i, '').replace(/-/g, ' ');
  const [bubbleOn, setBubbleOn] = useState(false);
  const toggleBubble = useCallback(async () => {
    try {
      if (bubbleOn) {
        await overlay.disable();
        setBubbleOn(false);
      } else {
        const on = await overlay.enable();
        setBubbleOn(on);
      }
    } catch {
      setBubbleOn(false);
    }
  }, [bubbleOn]);

  return (
    <View style={styles.header}>
      <Text style={styles.wordmark}>
        minimus<Text style={styles.wordmarkDot}> ●</Text>
      </Text>
      <View style={styles.headerRight}>
        {overlay.available() ? (
          <TouchableOpacity
            style={[styles.bubbleBtn, bubbleOn && styles.bubbleBtnOn]}
            onPress={() => void toggleBubble()}
            hitSlop={8}
          >
            <View style={[styles.bubbleGlyph, bubbleOn && styles.bubbleGlyphOn]} />
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity style={styles.statusPill} onPress={onOpenModels}>
          <View style={styles.statusDot} />
          <Text style={styles.statusText}>{modelLabel} · on-device</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function EmptyState({ onPick }: { onPick: (s: string) => void }): React.JSX.Element {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyMark}>
        agent<Text style={styles.wordmarkDot}> ●</Text>
      </Text>
      <Text style={styles.emptyLine}>Your phone, doing things for you.{'\n'}No cloud involved.</Text>
      <View style={styles.chips}>
        {SUGGESTIONS.map((s) => (
          <TouchableOpacity key={s} style={styles.chip} onPress={() => onPick(s)}>
            <Text style={styles.chipText}>{s}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

function WorkingRow(): React.JSX.Element {
  return (
    <View style={styles.working}>
      <LiveDot />
      <Text style={styles.workingText}>working</Text>
    </View>
  );
}

function ItemView({ item }: { item: Item }): React.JSX.Element | null {
  switch (item.kind) {
    case 'user':
      return (
        <View style={styles.userPill}>
          <Text style={styles.userText}>{item.text}</Text>
        </View>
      );
    case 'agent':
      return (
        <FadeIn>
          <View style={styles.agentBlock}>
            <AgentText text={item.text} />
          </View>
        </FadeIn>
      );
    case 'rail':
      return <ActionRail ops={item.ops} />;
    case 'approval':
      if (item.resolved) {
        return (
          <Text style={styles.approvalResolved}>
            {item.resolved === 'yes' ? '✓ approved' : '— skipped'}
          </Text>
        );
      }
      return (
        <ApprovalCard title={item.title} detail={item.detail} onDecision={item.resolve} />
      );
    default:
      return null;
  }
}

function FadeIn({ children }: { children: React.ReactNode }): React.JSX.Element {
  const opacity = useRef(new Animated.Value(0)).current;
  React.useEffect(() => {
    Animated.timing(opacity, { toValue: 1, duration: 260, useNativeDriver: true }).start();
  }, [opacity]);
  return <Animated.View style={{ opacity }}>{children}</Animated.View>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg0 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space(4),
    paddingVertical: space(3),
  },
  wordmark: { color: color.text, fontSize: 20, fontWeight: '800', letterSpacing: 0.5 },
  wordmarkDot: { color: color.amber, fontSize: 12 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: space(2) },
  bubbleBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: color.line,
    backgroundColor: color.bg1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bubbleBtnOn: { borderColor: color.amberDeep },
  bubbleGlyph: { width: 10, height: 10, borderRadius: 5, backgroundColor: color.faint },
  bubbleGlyphOn: { backgroundColor: color.amber },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space(1.5),
    backgroundColor: color.bg1,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: color.line,
    paddingHorizontal: space(2.5),
    paddingVertical: space(1.25),
  },
  statusDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: color.ok },
  statusText: { color: color.dim, fontSize: 11, fontFamily: font.mono },

  list: { flex: 1 },
  listContent: { paddingHorizontal: space(4), paddingBottom: space(4), gap: space(3) },

  userPill: {
    alignSelf: 'flex-end',
    backgroundColor: color.bg2,
    borderRadius: 18,
    borderTopRightRadius: 6,
    paddingHorizontal: space(3.5),
    paddingVertical: space(2.5),
    maxWidth: '85%',
    marginTop: space(2),
  },
  userText: { color: color.text, fontSize: 15, lineHeight: 21 },

  agentBlock: { marginTop: space(1) },

  working: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space(2),
    paddingVertical: space(2),
  },
  workingText: { color: color.faint, fontSize: 12, fontFamily: font.mono },

  approvalResolved: { color: color.faint, fontSize: 12, fontFamily: font.mono },

  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space(6) },
  emptyMark: { color: color.text, fontSize: 40, fontWeight: '800', letterSpacing: 1 },
  emptyLine: {
    color: color.dim,
    fontSize: 14,
    lineHeight: 21,
    textAlign: 'center',
    marginTop: space(3),
    marginBottom: space(6),
  },
  chips: { gap: space(2), alignSelf: 'stretch' },
  chip: {
    backgroundColor: color.bg1,
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: 12,
    paddingVertical: space(3),
    paddingHorizontal: space(4),
  },
  chipText: { color: color.text, fontSize: 14 },
});
