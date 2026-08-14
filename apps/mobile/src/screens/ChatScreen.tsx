import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  FlatList,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { AgentLoop, type AgentEvent, type ToolCall } from '@minimus/agent-core';
import { LocalAdapter } from '../services/LocalAdapter';
import { RemoteAdapter } from '../services/RemoteAdapter';
import { getToolRegistry } from '../tools';
import { useModelStore } from '../stores/modelStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useSessionStore, type SessionMessage } from '../stores/sessionStore';
import { verbFor, resultFor } from '../services/humanize';
import { overlay } from '../services/overlay';
import { scheduler } from '../services/scheduler';
import { runAgentHeadless } from '../services/headlessAgent';
import { diag } from '../services/diag';
import { loadMacros } from '../tools/macroTools';
import {
  deferredPreamble,
  deferredToolExclusions,
  isTeaching,
  macroSteering,
  routeToolGroups,
  teachingPreamble,
  teachingToolExclusions,
} from '../services/intent';
import { userExcludedTools, userToolGroups } from '../services/toolPlatform';
import { ActionRail, type Operation } from '../components/ActionRail';
import { AgentText } from '../components/AgentText';
import { ApprovalCard } from '../components/ApprovalCard';
import { Composer } from '../components/Composer';
import { LiveDot } from '../components/LiveDot';
import { color, font, radius, space } from '../theme';

/**
 * E.V conversation surface. The stream of raw model tokens NEVER renders —
 * the UI shows: quiet user pills, the action rail (live operations), a
 * "working" shimmer while the model runs, and the parsed answer typeset
 * plainly once each turn resolves. Tool syntax is invisible by construction.
 */

type Item =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'scheduled'; id: string; text: string }
  | { kind: 'agent'; id: string; text: string }
  | { kind: 'sources'; id: string; sources: Source[] }
  | { kind: 'rail'; id: string; ops: Operation[] }
  | {
      kind: 'approval';
      id: string;
      title: string;
      detail: string;
      resolve: (ok: boolean) => void;
      resolved?: 'yes' | 'no';
    };

interface Source {
  title: string;
  url: string;
}

/** Pull {results:[{title,url}]} out of a web_search tool result string. */
function sourcesFrom(resultJson: string): Source[] {
  try {
    const parsed = JSON.parse(resultJson) as { results?: { title?: string; url?: string }[] };
    return (parsed.results ?? [])
      .filter((r): r is { title: string; url: string } => Boolean(r.title && r.url))
      .map((r) => ({ title: r.title, url: r.url }));
  } catch {
    return [];
  }
}

function domainOf(url: string): string {
  const m = /^https?:\/\/(?:www\.)?([^/]+)/i.exec(url);
  return m?.[1] ?? url;
}

// Seeded with time so Fast Refresh (which resets module state) can never
// mint ids that collide with items already in React state.
let idCounter = 0;
const idSeed = Date.now().toString(36);
const nextId = () => `i${idSeed}_${++idCounter}`;

const registry = getToolRegistry();

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
  onOpenRehearsal,
  onOpenSettings,
  onOpenHistory,
  onOpenTools,
}: {
  onOpenModels?: () => void;
  onOpenRehearsal?: () => void;
  onOpenSettings?: () => void;
  onOpenHistory?: () => void;
  onOpenTools?: () => void;
}): React.JSX.Element {
  const activeModelId = useModelStore((s) => s.activeModelId);
  const remote = useSettingsStore((s) => s.remote);
  const requireApprovals = useSettingsStore((s) => s.requireApprovals);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const [items, setItems] = useState<Item[]>([]);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);
  const [working, setWorking] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<FlatList<Item>>(null);

  const scrollDown = () =>
    requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));

  // Session switching: a new/reopened session replaces the visible transcript.
  // Restored runs render as plain text — rails and approvals are live-run UI.
  useEffect(() => {
    let stale = false;
    void useSessionStore
      .getState()
      .loadTranscript(activeSessionId)
      .then((transcript) => {
        if (stale) return;
        setItems(
          transcript.map((m): Item => {
            if (m.kind === 'sources') {
              let sources: Source[] = [];
              try {
                sources = JSON.parse(m.data ?? '[]') as Source[];
              } catch {
                sources = [];
              }
              return { kind: 'sources', id: nextId(), sources };
            }
            const kind = m.kind === 'user' || m.kind === 'scheduled' ? m.kind : 'agent';
            return { kind, id: nextId(), text: m.text };
          }),
        );
      });
    return () => {
      stale = true;
    };
  }, [activeSessionId]);

  const persist = (messages: SessionMessage[]) =>
    useSessionStore.getState().appendToActive(messages);

  const run = useCallback(
    async (prompt: string, origin: 'user' | 'scheduled' = 'user'): Promise<string> => {
      if (!prompt.trim() || runningRef.current) return '';
      runningRef.current = true;
      if (origin === 'user') setInput('');
      setRunning(true);
      setWorking(true);
      const abort = new AbortController();
      abortRef.current = abort;

      setItems((prev) => [
        ...prev,
        { kind: origin === 'scheduled' ? 'scheduled' : 'user', id: nextId(), text: prompt.trim() },
      ]);
      persist([
        { kind: origin === 'scheduled' ? 'scheduled' : 'user', text: prompt.trim(), atMs: Date.now() },
      ]);
      scrollDown();
      const runStartedAt = Date.now();
      const useRemote = remote.enabled && remote.baseUrl.trim() !== '' && remote.model.trim() !== '';
      diag(
        `run start (${origin}) model=${useRemote ? `remote:${remote.model}` : activeModelId} prompt=${JSON.stringify(prompt.trim().slice(0, 90))}`,
      );

      const adapter = useRemote
        ? new RemoteAdapter({
            baseUrl: remote.baseUrl.trim(),
            ...(remote.apiKey.trim() ? { apiKey: remote.apiKey.trim() } : {}),
            model: remote.model.trim(),
          })
        : new LocalAdapter(activeModelId);
      const loop = new AgentLoop();

      // Taught phrases have to be visible in the system prompt, or a bare
      // "wind down" reads as small talk instead of a macro invocation.
      const macros = await loadMacros().catch(() => []);
      const preambleLines = [
        'You are Minimus, running entirely on this phone. You get things DONE using tools, then confirm briefly.',
      ];
      // While TEACHING, the taught-phrases line is poison: it says "call
      // run_macro for this phrase" while the teaching line says "only
      // define_macro" — the model acts AND defines across 5-8 turns (rig:
      // teach-devstate 0/3 with the line, clean without).
      if (macros.length > 0 && !isTeaching(prompt)) {
        preambleLines.push(
          `Phrases the user has taught you (run these with run_macro): ${macros
            .map((m) => `"${m.name}"`)
            .join(', ')}. If the user says one of them, call run_macro with that name.`,
        );
      }
      if (origin === 'scheduled') {
        preambleLines.push(
          'This is a task you scheduled earlier and it is now due. Carry it out with your tools, then state the outcome in one short sentence.',
        );
      }
      const teaching = teachingPreamble(prompt);
      if (teaching) preambleLines.push(teaching);
      const deferred = deferredPreamble(prompt);
      if (deferred) preambleLines.push(deferred);
      const macroHit = macroSteering(prompt, macros.map((m) => m.name));
      if (macroHit) preambleLines.push(macroHit.line);
      const excludeTools = [
        ...deferredToolExclusions(prompt),
        ...teachingToolExclusions(prompt),
        ...(macroHit?.exclude ?? []),
        ...userExcludedTools(),
      ];
      // User-added tools (custom HTTP, MCP) ride along on every run — the
      // user opted them in explicitly, and each call is approval-gated.
      const toolGroups = [...routeToolGroups(prompt), ...userToolGroups()];
      diag(`tool groups: ${toolGroups.join(',')}`);

      let railId: string | null = null;
      let saidAnything = false;
      let lastOpSummary = '';
      let finalText = '';
      const runSources: Source[] = [];

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
          toolGroups,
          excludeTools,
          preamble: preambleLines.join('\n'),
          // Settings can waive approval prompts; denial stays the default
          // for anything that sends on the user's behalf.
          approvals: requireApprovals ? (req) => askApproval(req.call) : async () => true,
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
        runningRef.current = false;
        setRunning(false);
        setWorking(false);
        abortRef.current = null;
        scrollDown();
      }
      return finalText;

      function handle(ev: AgentEvent) {
        switch (ev.type) {
          case 'turn_started':
            setWorking(true);
            break;
          case 'assistant_turn':
            setWorking(false);
            diag(
              `turn ${ev.turn} answered: calls=${ev.toolCallCount} text=${JSON.stringify(ev.text.slice(0, 120))}`,
            );
            // Prose from a tool-calling turn is usually preamble ("Let me
            // check…") — show it only when it's the final answer-ish turn or
            // meaningfully long.
            if (ev.text && (ev.toolCallCount === 0 || ev.text.length > 80)) {
              saidAnything = true;
              setItems((prev) => [...prev, { kind: 'agent', id: nextId(), text: ev.text }]);
              persist([{ kind: 'agent', text: ev.text, atMs: Date.now() }]);
              scrollDown();
            }
            break;
          case 'tool_call_started':
            diag(`tool ${ev.call.name} args=${JSON.stringify(ev.call.arguments).slice(0, 160)}`);
            upsertRail((ops) => [
              ...ops,
              { id: ev.call.id, verb: verbFor(ev.call), status: 'running' },
            ]);
            setWorking(false);
            break;
          case 'tool_call_finished': {
            const summary = resultFor(ev.call, ev.result, ev.isError);
            diag(`tool ${ev.call.name} -> ${ev.isError ? 'ERROR ' : ''}${summary}`);
            if (!ev.isError) lastOpSummary = summary;
            if (!ev.isError && ev.call.name === 'web_search') {
              for (const s of sourcesFrom(ev.result)) {
                if (!runSources.some((x) => x.url === s.url)) runSources.push(s);
              }
            }
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
            diag(
              `run finished reason=${ev.reason} in ${((Date.now() - runStartedAt) / 1000).toFixed(1)}s${ev.error ? ` error=${ev.error}` : ''}`,
            );
            finalText = ev.finalText || (lastOpSummary ? `Done — ${lastOpSummary.toLowerCase()}.` : '');
            if (ev.reason === 'completed' && !saidAnything && lastOpSummary) {
              // The model acted but never spoke — close the loop honestly
              // with the last operation's result.
              const text = `Done — ${lastOpSummary.toLowerCase()}.`;
              setItems((prev) => [...prev, { kind: 'agent', id: nextId(), text }]);
              persist([{ kind: 'agent', text, atMs: Date.now() }]);
            }
            if (ev.reason === 'completed' && runSources.length > 0) {
              // The answer came from the web — show where. Tappable, honest.
              const sources = runSources.slice(0, 5);
              setItems((prev) => [...prev, { kind: 'sources', id: nextId(), sources }]);
              persist([
                { kind: 'sources', text: '', data: JSON.stringify(sources), atMs: Date.now() },
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
    [running, activeModelId, remote, requireApprovals],
  );

  // Deferred agency: when a scheduled task comes due the scheduler runs a
  // full agent loop through this same path, so the audience watches it think.
  useEffect(() => {
    scheduler.setRunner(async (instruction) => {
      for (let waited = 0; runningRef.current && waited < 120_000; waited += 500) {
        await new Promise((r) => setTimeout(r, 500));
      }
      return run(instruction, 'scheduled');
    });
    scheduler.start();
    void scheduler.tick();
    // Hand back to the headless runner rather than stopping the scheduler —
    // leaving this screen must not cancel a task the user already armed.
    return () => scheduler.setRunner(runAgentHeadless);
  }, [run]);

  const stop = useCallback(() => abortRef.current?.abort(), []);

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Header
        onOpenModels={onOpenModels}
        onOpenRehearsal={onOpenRehearsal}
        onOpenSettings={onOpenSettings}
        onOpenHistory={onOpenHistory}
        onOpenTools={onOpenTools}
        onNewChat={running ? undefined : () => useSessionStore.getState().newSession()}
      />
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

function Header({
  onOpenModels,
  onOpenRehearsal,
  onOpenSettings,
  onOpenHistory,
  onOpenTools,
  onNewChat,
}: {
  onOpenModels?: () => void;
  onOpenRehearsal?: () => void;
  onOpenSettings?: () => void;
  onOpenHistory?: () => void;
  onOpenTools?: () => void;
  onNewChat?: () => void;
}): React.JSX.Element {
  const remote = useSettingsStore((s) => s.remote);
  const usingRemote = remote.enabled && remote.baseUrl.trim() !== '' && remote.model.trim() !== '';
  const [menuOpen, setMenuOpen] = useState(false);
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

  // One status chip, one action, one menu. Everything else lives behind ⋯ —
  // a phone header is not a toolbar.
  const menuItems: { label: string; action?: () => void; on?: boolean }[] = [
    ...(onOpenHistory ? [{ label: 'Chats', action: onOpenHistory }] : []),
    ...(onOpenTools ? [{ label: 'Tools', action: onOpenTools }] : []),
    ...(onOpenModels ? [{ label: 'Models', action: onOpenModels }] : []),
    ...(onOpenSettings ? [{ label: 'Settings', action: onOpenSettings }] : []),
    ...(onOpenRehearsal ? [{ label: 'Rehearsal', action: onOpenRehearsal }] : []),
    ...(overlay.available()
      ? [{ label: bubbleOn ? 'Floating bubble · on' : 'Floating bubble · off', action: () => void toggleBubble(), on: bubbleOn }]
      : []),
  ];

  return (
    <View style={styles.header}>
      <Text style={styles.wordmark}>
        minimus<Text style={styles.wordmarkDot}> ●</Text>
      </Text>
      <View style={styles.headerRight}>
        <View style={styles.statusPill}>
          <View style={[styles.statusDot, usingRemote && styles.statusDotCloud]} />
          <Text style={styles.statusText}>{usingRemote ? 'cloud' : 'on-device'}</Text>
        </View>
        {onNewChat ? (
          <TouchableOpacity style={styles.bubbleBtn} onPress={onNewChat} hitSlop={8}>
            <Text style={styles.headerGlyph}>＋</Text>
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity style={styles.bubbleBtn} onPress={() => setMenuOpen(true)} hitSlop={8}>
          <Text style={styles.headerGlyph}>⋯</Text>
        </TouchableOpacity>
      </View>
      <Modal transparent visible={menuOpen} animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        <TouchableOpacity style={styles.menuBackdrop} activeOpacity={1} onPress={() => setMenuOpen(false)}>
          <View style={styles.menuSheet}>
            {menuItems.map((item) => (
              <TouchableOpacity
                key={item.label}
                style={styles.menuRow}
                onPress={() => {
                  setMenuOpen(false);
                  item.action?.();
                }}
              >
                <Text style={[styles.menuLabel, item.on && styles.menuLabelOn]}>{item.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </TouchableOpacity>
      </Modal>
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
    case 'scheduled':
      return (
        <View style={styles.scheduledPill}>
          <Text style={styles.scheduledLabel}>scheduled task · running now</Text>
          <Text style={styles.scheduledText}>{item.text}</Text>
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
    case 'sources':
      return (
        <FadeIn>
          <View style={styles.sourcesBlock}>
            <Text style={styles.sourcesLabel}>sources</Text>
            {item.sources.map((s) => (
              <TouchableOpacity
                key={s.url}
                style={styles.sourceRow}
                onPress={() => void Linking.openURL(s.url).catch(() => {})}
              >
                <Text style={styles.sourceTitle} numberOfLines={1}>
                  {s.title}
                </Text>
                <Text style={styles.sourceDomain}>{domainOf(s.url)}</Text>
              </TouchableOpacity>
            ))}
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
  rehearseGlyph: { color: color.faint, fontSize: 14, fontWeight: '700' },
  headerGlyph: { color: color.faint, fontSize: 15, fontWeight: '600' },
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
  statusDotCloud: { backgroundColor: color.amber },
  statusText: { color: color.dim, fontSize: 11, fontFamily: font.mono },

  menuBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-start',
    alignItems: 'flex-end',
    paddingTop: space(14),
    paddingRight: space(4),
  },
  menuSheet: {
    minWidth: 200,
    backgroundColor: color.bg1,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: color.line,
    paddingVertical: space(1),
  },
  menuRow: { paddingHorizontal: space(4), paddingVertical: space(3) },
  menuLabel: { color: color.text, fontSize: 15 },
  menuLabelOn: { color: color.amber },

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
  scheduledPill: {
    alignSelf: 'flex-start',
    backgroundColor: color.bg1,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: color.amberDeep,
    paddingHorizontal: space(3.5),
    paddingVertical: space(2.5),
    maxWidth: '92%',
    marginTop: space(2),
    gap: space(1),
  },
  scheduledLabel: {
    color: color.amber,
    fontFamily: font.mono,
    fontSize: 10,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
  },
  scheduledText: { color: color.text, fontSize: 14, lineHeight: 20 },

  agentBlock: { marginTop: space(1) },

  sourcesBlock: {
    marginTop: space(1),
    borderLeftWidth: 2,
    borderLeftColor: color.line,
    paddingLeft: space(3),
    gap: space(1.5),
  },
  sourcesLabel: {
    color: color.faint,
    fontSize: 10,
    fontFamily: font.mono,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  sourceRow: { flexDirection: 'row', alignItems: 'baseline', gap: space(2) },
  sourceTitle: { color: color.cyan, fontSize: 12, flexShrink: 1 },
  sourceDomain: { color: color.faint, fontSize: 10, fontFamily: font.mono },

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
