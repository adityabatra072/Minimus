import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  FlatList,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  AgentLoop,
  extractReasoning,
  matchReflex,
  policyFor,
  effectiveCategories,
  routeWithModel,
  type AgentEvent,
  type RouterCategory,
  type ToolCall,
} from '@minimus/agent-core';
import { launchImageLibrary } from 'react-native-image-picker';
import { LocalAdapter } from '../services/LocalAdapter';
import { RemoteAdapter } from '../services/RemoteAdapter';
import { engine } from '../services/engine';
import { getToolRegistry } from '../tools';
import { useModelStore } from '../stores/modelStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useSessionStore, type SessionMessage } from '../stores/sessionStore';
import { verbFor, resultFor } from '../services/humanize';
import { scheduler } from '../services/scheduler';
import { runAgentHeadless } from '../services/headlessAgent';
import { diag } from '../services/diag';
import { loadMacros } from '../tools/macroTools';
import { clockHeadline, useClockStore } from '../services/clock';
import { matchingFacts } from '../tools/memoryTools';
import { composeRun } from '../services/intent';
import { acquireRun, isRunBusy, releaseRun } from '../services/runLock';
import { userExcludedTools, userToolGroups } from '../services/toolPlatform';
import { ensureVoiceReady, VoicePipeline, type VoiceState } from '../services/voice';
import { setAttachedImage } from '../tools/visionTools';
import { registerQaHandler } from '../services/qaBridge';
import { allModels, type ModelSpec } from '../services/models';
import { deviceHealth } from '../services/health';
import { Receipt, type Operation, type ReceiptFooter } from '../components/Receipt';
import { AgentText, Sources, ThinkingLine, type Source } from '../components/AgentText';
import { ApprovalCard } from '../components/ApprovalCard';
import { Composer } from '../components/Composer';
import { Core, type CoreState } from '../ui/Core';
import { Label } from '../ui/primitives';
import { GlyphClock, GlyphMenu, GlyphPlus } from '../ui/glyphs';
import { elevation, font, radius, space, usePalette } from '../theme';

/**
 * Home: the conversation. What the model streams is shown live — a faded
 * glimpse of its thinking, then the answer as it types — and every tool it
 * runs is a line on a receipt. Raw tool syntax never renders.
 */

export type Destination = 'history' | 'brain' | 'tools' | 'memory' | 'settings' | 'diagnostics' | 'clock';

type Item =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'scheduled'; id: string; text: string }
  | { kind: 'agent'; id: string; text: string }
  | { kind: 'live'; id: string; text: string; reasoning: string; startedAt: number; thinkingDone?: boolean }
  | { kind: 'sources'; id: string; sources: Source[] }
  | { kind: 'receipt'; id: string; ops: Operation[]; footer?: ReceiptFooter }
  | { kind: 'notice'; id: string; text: string; tone: 'muted' | 'danger' }
  | {
      kind: 'approval';
      id: string;
      title: string;
      detail: string;
      resolve: (ok: boolean) => void;
      resolved?: 'yes' | 'no';
    };

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

let idCounter = 0;
const idSeed = Date.now().toString(36);
const nextId = () => `i${idSeed}_${++idCounter}`;

const registry = getToolRegistry();

interface Capability {
  title: string;
  blurb: string;
  examples: string[];
}

const CAPABILITIES: Capability[] = [
  { title: 'Phone', blurb: 'Torch, brightness, battery, apps', examples: ['Turn on the flashlight', 'How much battery do I have?', 'Open Spotify'] },
  { title: 'Calendar', blurb: 'Reads your day, finds gaps, books', examples: ['What have I got tomorrow?', 'Find me an hour for the gym tomorrow afternoon and put it in'] },
  { title: 'Remember', blurb: 'Facts that stay on this phone', examples: ['Remember that my locker code is 4471', 'What did I tell you about Thursday?'] },
  { title: 'Later', blurb: 'It checks back on its own', examples: ['In 20 minutes check my battery and tell me if it dropped', 'Tonight at 9 remind me to charge my phone'] },
  { title: 'Teach', blurb: 'Your own phrases, replayed instantly', examples: ['New rule: when I say wind down, set brightness to 20 percent and turn the flashlight off'] },
  { title: 'Look up', blurb: 'Web search with sources', examples: ['Who won the last Monaco Grand Prix?', 'What time does the sun set today in London?'] },
];

function approvalSummary(call: ToolCall): { title: string; detail: string } {
  const a = call.arguments;
  switch (call.name) {
    case 'send_email':
      return { title: `Email ${String(a['to'] ?? '')}`, detail: `${a['subject'] ? `${String(a['subject'])} — ` : ''}${String(a['body'] ?? '')}` };
    case 'send_sms':
      return { title: `Text ${String(a['to'] ?? '')}`, detail: String(a['body'] ?? '') };
    case 'make_call':
      return { title: `Call ${String(a['to'] ?? '')}`, detail: '' };
    default:
      return { title: verbFor(call), detail: JSON.stringify(call.arguments).slice(0, 160) };
  }
}

function greeting(): string {
  const h = new Date().getHours();
  return h < 5 ? 'Still up?' : h < 12 ? 'Good morning.' : h < 17 ? 'Good afternoon.' : 'Good evening.';
}

export default function ChatScreen({ onOpen }: { onOpen: (d: Destination) => void }): React.JSX.Element {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const activeModelId = useModelStore((s) => s.activeModelId);
  const engineState = useModelStore((s) => s.engineState);
  const remote = useSettingsStore((s) => s.remote);
  const requireApprovals = useSettingsStore((s) => s.requireApprovals);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const [items, setItems] = useState<Item[]>([]);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [coreState, setCoreState] = useState<CoreState>('idle');
  const [menuOpen, setMenuOpen] = useState(false);
  const [models, setModels] = useState<ModelSpec[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<FlatList<Item>>(null);
  const [voiceState, setVoiceState] = useState<VoiceState>('idle');
  const [voiceDetail, setVoiceDetail] = useState('');
  const [attachment, setAttachment] = useState<{ path: string; name: string } | null>(null);
  const [toolsEnabled, setToolsEnabled] = useState(true);
  const toolsEnabledRef = useRef(toolsEnabled);
  toolsEnabledRef.current = toolsEnabled;
  const voiceRef = useRef<VoicePipeline | null>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  useEffect(() => {
    void allModels().then(setModels);
  }, []);
  const modelSpec = models.find((m) => m.id === activeModelId);

  const scrollDown = () => requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));

  // Session switching: a new/reopened session replaces the visible transcript.
  useEffect(() => {
    let stale = false;
    void useSessionStore
      .getState()
      .loadTranscript(activeSessionId)
      .then((transcript) => {
        if (stale) return;
        setItems(
          transcript.flatMap((m): Item[] => {
            if (m.kind === 'sources') {
              try {
                return [{ kind: 'sources', id: nextId(), sources: JSON.parse(m.data ?? '[]') as Source[] }];
              } catch {
                return [];
              }
            }
            if (m.kind === 'rail-summary') {
              try {
                const parsed = JSON.parse(m.data ?? '{}') as { ops?: Operation[]; footer?: ReceiptFooter };
                return [{ kind: 'receipt', id: nextId(), ops: parsed.ops ?? [], ...(parsed.footer ? { footer: parsed.footer } : {}) }];
              } catch {
                return [];
              }
            }
            const kind = m.kind === 'user' || m.kind === 'scheduled' ? m.kind : 'agent';
            return [{ kind, id: nextId(), text: m.text }];
          }),
        );
      });
    return () => {
      stale = true;
    };
  }, [activeSessionId]);

  const persist = (messages: SessionMessage[]) => useSessionStore.getState().appendToActive(messages);

  const run = useCallback(
    async (prompt: string, origin: 'user' | 'scheduled' = 'user'): Promise<string> => {
      if (!prompt.trim() || !acquireRun()) return '';
      if (origin === 'user') setInput('');
      setRunning(true);
      setCoreState('thinking');
      const abort = new AbortController();
      abortRef.current = abort;

      setItems((prev) => [...prev, { kind: origin === 'scheduled' ? 'scheduled' : 'user', id: nextId(), text: prompt.trim() }]);
      persist([{ kind: origin === 'scheduled' ? 'scheduled' : 'user', text: prompt.trim(), atMs: Date.now() }]);
      scrollDown();
      const runStartedAt = Date.now();
      const useRemote = remote.enabled && remote.baseUrl.trim() !== '' && remote.model.trim() !== '';
      diag(`run start (${origin}) model=${useRemote ? `remote:${remote.model}` : activeModelId} prompt=${JSON.stringify(prompt.trim().slice(0, 90))}`);

      const finish = () => {
        releaseRun();
        setRunning(false);
        setCoreState('idle');
        abortRef.current = null;
        setAttachment(null);
        setAttachedImage(null);
        scrollDown();
      };

      let receiptId: string | null = null;
      const upsertReceipt = (mutate: (ops: Operation[]) => Operation[], footer?: ReceiptFooter) => {
        setItems((prev) => {
          if (receiptId === null) {
            receiptId = nextId();
            return [...prev, { kind: 'receipt', id: receiptId, ops: mutate([]), ...(footer ? { footer } : {}) }];
          }
          return prev.map((it) =>
            it.id === receiptId && it.kind === 'receipt' ? { ...it, ops: mutate(it.ops), ...(footer ? { footer } : {}) } : it,
          );
        });
        scrollDown();
      };
      const persistReceipt = (ops: Operation[], footer: ReceiptFooter) =>
        persist([{ kind: 'rail-summary', text: '', data: JSON.stringify({ ops, footer }), atMs: Date.now() }]);

      const macros = await loadMacros().catch(() => []);
      const relevantFacts = await matchingFacts(prompt).catch(() => []);
      if (relevantFacts.length) diag(`memory: ${relevantFacts.length} relevant fact(s)`);
      const noTools = origin === 'user' && !toolsEnabledRef.current;
      const baseOptions = {
        toolsByGroup: registry.byGroup(),
        macroNames: macros.map((m) => m.name),
        macros,
        relevantFacts,
        origin: origin === 'scheduled' ? ('scheduled' as const) : ('user' as const),
        hasAttachment: !!attachment,
        extraToolGroups: userToolGroups(),
        extraExcludeTools: userExcludedTools(),
      };

      // ---- reflex: an unambiguous command needs no model ----
      if (origin === 'user' && !attachment && !noTools) {
        const full = composeRun(prompt, baseOptions);
        const exposed = new Set(registry.list(full.toolGroups).map((t) => t.name).filter((n) => !full.excludeTools.includes(n)));
        const reflex = matchReflex(prompt, macros.map((m) => m.name), exposed);
        const tool = reflex ? registry.get(reflex.call.name) : undefined;
        if (reflex && tool && !registry.requiresApproval(reflex.call)) {
          setCoreState('acting');
          diag(`reflex ${reflex.call.name} ${JSON.stringify(reflex.call.arguments)}`);
          upsertReceipt(() => [{ id: reflex.call.id, verb: verbFor(reflex.call), status: 'running' }]);
          try {
            const raw = await tool.execute(reflex.call.arguments, { signal: abort.signal });
            const resultText = typeof raw === 'string' ? raw : JSON.stringify(raw);
            const parsed = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown>;
            const summary = resultFor(reflex.call, resultText, false);
            const text = typeof reflex.confirm === 'function' ? reflex.confirm(parsed) : reflex.confirm;
            const ops: Operation[] = [{ id: reflex.call.id, verb: verbFor(reflex.call), status: 'reflex', result: summary }];
            const footer: ReceiptFooter = { steps: 1, seconds: (Date.now() - runStartedAt) / 1000, via: 'instant' };
            upsertReceipt(() => ops, footer);
            setItems((prev) => [...prev, { kind: 'agent', id: nextId(), text }]);
            persistReceipt(ops, footer);
            persist([{ kind: 'agent', text, atMs: Date.now() }]);
            diag(`reflex done in ${Date.now() - runStartedAt}ms`);
            finish();
            return text;
          } catch (err) {
            // The tool failed; let the model handle it with the error in view.
            diag(`reflex failed, falling back to the model: ${err instanceof Error ? err.message : String(err)}`);
            upsertReceipt(() => []);
            receiptId = null;
          }
        }
      }

      if (!useRemote) {
        try {
          await useModelStore.getState().ensureLoaded();
        } catch (err) {
          setItems((prev) => [
            ...prev,
            { kind: 'notice', id: nextId(), tone: 'danger', text: `The model could not be loaded: ${err instanceof Error ? err.message : String(err)}` },
          ]);
          finish();
          return '';
        }
      }
      const adapter = useRemote
        ? new RemoteAdapter({ baseUrl: remote.baseUrl.trim(), ...(remote.apiKey.trim() ? { apiKey: remote.apiKey.trim() } : {}), model: remote.model.trim() })
        : new LocalAdapter(activeModelId);

      // ---- router: decide which tools this message may see ----
      // A short grammar-constrained pass on the same model. "none" means a
      // plain conversation with no tools at all, which is what stops a
      // greeting from running a taught phrase or reading the battery.
      let categories: RouterCategory[] | undefined;
      let routeMs = 0;
      if (!noTools && !useRemote && !abort.signal.aborted) {
        try {
          const decision = await routeWithModel(new LocalAdapter(activeModelId, 'router'), prompt, abort.signal);
          categories = effectiveCategories(decision.categories, prompt);
          routeMs = decision.ms;
          diag(`route ${JSON.stringify(decision.categories)}${categories ? '' : ' (overruled: action verb → all tools)'} in ${decision.ms}ms raw=${JSON.stringify(decision.raw)}`);
        } catch (err) {
          diag(`route failed, exposing everything: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (abort.signal.aborted) {
        setItems((prev) => [...prev, { kind: 'notice', id: nextId(), tone: 'muted', text: 'Stopped.' }]);
        finish();
        return '';
      }
      // What came before in this chat, newest last, capped so a long
      // conversation cannot crowd out the tools. A reopened chat gets its
      // history back in front of the model this way.
      const history: { role: 'user' | 'assistant'; content: string }[] = [];
      let budget = 2400;
      for (let i = itemsRef.current.length - 2; i >= 0 && budget > 0; i--) {
        const it = itemsRef.current[i]!;
        if (it.kind !== 'user' && it.kind !== 'agent' && it.kind !== 'scheduled') continue;
        const content = it.text.slice(0, 600);
        budget -= content.length;
        if (budget < 0) break;
        history.unshift({ role: it.kind === 'agent' ? 'assistant' : 'user', content });
      }
      const composition = composeRun(prompt, { ...baseOptions, ...(categories ? { categories } : {}), noTools, toolsByGroup: registry.byGroup() });
      const { toolGroups, excludeTools, allowExecuteOnly, allowExecuteReason, denyTools, preamble, deliberate } = composition;
      const loop = new AgentLoop();
      diag(`tool groups: ${toolGroups.join(',') || '(none)'}${deliberate ? ' (deliberate)' : ''}`);

      let saidAnything = false;
      let lastOpSummary = '';
      let finalText = '';
      let steps = 0;
      let lastTps = 0;
      const runSources: Source[] = [];
      let liveId: string | null = null;
      let rawTurn = '';
      let liveTimer: ReturnType<typeof setTimeout> | null = null;

      const paintLive = () => {
        liveTimer = null;
        const { text, reasoning } = extractReasoning(rawTurn);
        const closed = rawTurn.includes('</think>') || !rawTurn.includes('<think>');
        setItems((prev) => {
          const clean = text.replace(/<\|tool_call_start\|>[\s\S]*$/, '').replace(/\[[a-z_]+\([\s\S]*$/, '');
          if (liveId === null) {
            liveId = nextId();
            return [...prev, { kind: 'live', id: liveId, text: clean, reasoning, startedAt: Date.now(), thinkingDone: closed }];
          }
          return prev.map((it) => (it.id === liveId && it.kind === 'live' ? { ...it, text: clean, reasoning, thinkingDone: closed } : it));
        });
        scrollDown();
      };
      const dropLive = () => {
        if (liveTimer) clearTimeout(liveTimer);
        liveTimer = null;
        if (liveId !== null) {
          const id = liveId;
          liveId = null;
          setItems((prev) => prev.filter((it) => it.id !== id));
        }
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
                setItems((q) => q.map((it) => (it.id === id && it.kind === 'approval' ? { ...it, resolved: ok ? 'yes' : 'no' } : it)));
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
          ...(allowExecuteOnly ? { allowExecuteOnly } : {}),
          ...(allowExecuteReason ? { allowExecuteReason } : {}),
          denyTools,
          preamble,
          deliberate,
          history,
          policy: useRemote ? policyFor(adapter.modelId) : { ...policyFor(adapter.modelId), contextWindowTokens: engine.getInfo()?.contextTokens ?? 8192 },
          approvals: requireApprovals ? (req) => askApproval(req.call) : async () => true,
          signal: abort.signal,
        });
        for await (const ev of events) handle(ev);
      } catch (err) {
        dropLive();
        setItems((prev) => [...prev, { kind: 'notice', id: nextId(), tone: 'danger', text: `Something went wrong: ${err instanceof Error ? err.message : String(err)}` }]);
      } finally {
        dropLive();
        finish();
      }
      return finalText;

      function handle(ev: AgentEvent) {
        switch (ev.type) {
          case 'turn_started':
            rawTurn = '';
            setCoreState('thinking');
            break;
          case 'text_delta':
            rawTurn += ev.text;
            if (!liveTimer) liveTimer = setTimeout(paintLive, 200);
            break;
          case 'generation_stats':
            if (ev.usage.decodeTokensPerSec) lastTps = ev.usage.decodeTokensPerSec;
            diag(
              `turn ${ev.turn} stats: prompt=${ev.usage.promptTokens} cached=${ev.usage.cachedTokens} out=${ev.usage.completionTokens} prefill=${ev.usage.promptTokensPerSec?.toFixed(0)}tok/s decode=${ev.usage.decodeTokensPerSec?.toFixed(1)}tok/s`,
            );
            break;
          case 'assistant_turn':
            dropLive();
            diag(`turn ${ev.turn} answered: calls=${ev.toolCallCount} text=${JSON.stringify(ev.text.slice(0, 120))}`);
            if (ev.text && (ev.toolCallCount === 0 || ev.text.length > 80)) {
              saidAnything = true;
              setItems((prev) => [...prev, { kind: 'agent', id: nextId(), text: ev.text }]);
              persist([{ kind: 'agent', text: ev.text, atMs: Date.now() }]);
              scrollDown();
            }
            break;
          case 'tool_call_started':
            diag(`tool ${ev.call.name} args=${JSON.stringify(ev.call.arguments).slice(0, 160)}`);
            setCoreState('acting');
            upsertReceipt((ops) => [...ops, { id: ev.call.id, verb: verbFor(ev.call), status: 'running' }]);
            break;
          case 'tool_call_refused':
            diag(`tool ${ev.call.name} refused: ${ev.reason}`);
            setItems((prev) => prev.map((it) => (it.kind === 'receipt' ? { ...it, ops: it.ops.filter((o) => o.id !== ev.call.id) } : it)));
            break;
          case 'tool_call_finished': {
            const summary = resultFor(ev.call, ev.result, ev.isError);
            diag(`tool ${ev.call.name} -> ${ev.isError ? 'ERROR ' : ''}${summary}`);
            if (!ev.isError) {
              lastOpSummary = summary;
              steps++;
            }
            if (!ev.isError && ev.call.name === 'web_search') {
              for (const s of sourcesFrom(ev.result)) if (!runSources.some((x) => x.url === s.url)) runSources.push(s);
            }
            upsertReceipt((ops) => {
              const done: Operation = { id: ev.call.id, verb: verbFor(ev.call), status: ev.isError ? 'error' : 'ok', result: summary };
              return ops.some((o) => o.id === ev.call.id) ? ops.map((o) => (o.id === ev.call.id ? done : o)) : [...ops, done];
            });
            setCoreState('thinking');
            break;
          }
          case 'approval_resolved':
            if (!ev.approved) upsertReceipt((ops) => [...ops, { id: ev.call.id, verb: verbFor(ev.call), status: 'denied', result: 'Skipped' }]);
            break;
          case 'parse_retry':
            diag(`retry: ${ev.reason}`);
            break;
          case 'run_finished': {
            const seconds = (Date.now() - runStartedAt) / 1000;
            void deviceHealth().then((h) => {
              if (h.thermal === 'serious' || h.thermal === 'critical') {
                setItems((prev) => [...prev, { kind: 'notice', id: nextId(), tone: 'muted', text: 'The phone is warm, so answers are slower than usual. It speeds back up as it cools.' }]);
              }
            });
            diag(`run finished reason=${ev.reason} in ${seconds.toFixed(1)}s${ev.error ? ` error=${ev.error}` : ''}`);
            finalText = ev.finalText || (lastOpSummary ? `Done — ${lastOpSummary.toLowerCase()}.` : '');
            if (ev.reason === 'completed' && !saidAnything && lastOpSummary) {
              const text = `Done — ${lastOpSummary.toLowerCase()}.`;
              setItems((prev) => [...prev, { kind: 'agent', id: nextId(), text }]);
              persist([{ kind: 'agent', text, atMs: Date.now() }]);
            }
            if (receiptId !== null || steps > 0) {
              const footer: ReceiptFooter = {
                steps,
                seconds,
                ...(lastTps ? { tps: lastTps } : {}),
                via: useRemote ? 'cloud' : 'on device',
                ...(modelSpec ? { model: modelSpec.name } : {}),
                ...(categories ? { route: `${categories.join('+')} · ${(routeMs / 1000).toFixed(1)} s` } : {}),
              };
              setItems((prev) => {
                const receipt = prev.find((it) => it.id === receiptId);
                if (receipt && receipt.kind === 'receipt') persistReceipt(receipt.ops, footer);
                return prev.map((it) => (it.id === receiptId && it.kind === 'receipt' ? { ...it, footer } : it));
              });
            }
            if (ev.reason === 'completed' && runSources.length > 0) {
              const sources = runSources.slice(0, 5);
              setItems((prev) => [...prev, { kind: 'sources', id: nextId(), sources }]);
              persist([{ kind: 'sources', text: '', data: JSON.stringify(sources), atMs: Date.now() }]);
            }
            if (ev.reason === 'max_turns') {
              setItems((prev) => [...prev, { kind: 'notice', id: nextId(), tone: 'muted', text: 'I ran out of steps before finishing that. Try breaking it into smaller asks.' }]);
            } else if (ev.reason === 'error' && ev.error) {
              setItems((prev) => [...prev, { kind: 'notice', id: nextId(), tone: 'danger', text: `I hit a problem: ${ev.error}` }]);
            } else if (ev.reason === 'cancelled') {
              setItems((prev) => [...prev, { kind: 'notice', id: nextId(), tone: 'muted', text: 'Stopped.' }]);
            }
            break;
          }
          default:
            break;
        }
      }
    },
    [activeModelId, remote, requireApprovals, attachment, modelSpec],
  );

  const pickImage = useCallback(async () => {
    const result = await launchImageLibrary({ mediaType: 'photo', selectionLimit: 1, quality: 0.8 });
    const asset = result.assets?.[0];
    if (!asset?.uri) return;
    const path = asset.uri.replace(/^file:\/\//, '');
    setAttachment({ path, name: asset.fileName ?? 'photo' });
    setAttachedImage(path);
  }, []);

  // Voice: mic tap → listen → transcribe → same run() as typed input → speak.
  const runRef = useRef(run);
  runRef.current = run;
  const handsFree = useSettingsStore((s) => s.voiceHandsFree);
  const handsFreeRef = useRef(handsFree);
  handsFreeRef.current = handsFree;

  const getVoice = useCallback((): VoicePipeline => {
    if (!voiceRef.current) {
      voiceRef.current = new VoicePipeline({
        onState: (state, detail) => {
          setVoiceState(state);
          setCoreState(state === 'listening' ? 'listening' : state === 'speaking' ? 'speaking' : 'idle');
          if (state !== 'listening') setVoiceDetail('');
          if (detail) diag(`voice: ${state} (${detail})`);
        },
        onPartial: (text) => setVoiceDetail(text),
        onUtterance: (text) => {
          void (async () => {
            const finalText = await runRef.current(text, 'user');
            const pipeline = voiceRef.current;
            if (!pipeline) return;
            if (finalText) await pipeline.speak(finalText);
            if (handsFreeRef.current) {
              pipeline.setRequireWake(true);
              await pipeline.start().catch(() => setVoiceState('idle'));
            }
          })();
        },
      });
    }
    return voiceRef.current;
  }, []);

  const armVoice = useCallback(
    async (mode: 'pushToTalk' | 'handsFree') => {
      const pipeline = getVoice();
      setVoiceState('preparing');
      await ensureVoiceReady((label) => setVoiceDetail(label));
      const macros = await loadMacros().catch(() => []);
      pipeline.setMacroNames(macros.map((m) => m.name));
      // The first utterance never needs the wake phrase: the user just tapped
      // or asked for us. Hands-free re-arms after the answer gate on it.
      pipeline.setRequireWake(false);
      await pipeline.start({ pushToTalk: mode === 'pushToTalk' });
    },
    [getVoice],
  );

  const onMic = useCallback(async () => {
    const pipeline = getVoice();
    if (voiceState === 'speaking') {
      await pipeline.stopSpeaking();
      return;
    }
    if (voiceState === 'listening') {
      const heard = await pipeline.stopAndTranscribe();
      if (!heard) return;
      const finalText = await runRef.current(heard, 'user');
      if (finalText) await pipeline.speak(finalText);
      return;
    }
    if (voiceState === 'transcribing' || voiceState === 'preparing') return;
    try {
      await armVoice('pushToTalk');
    } catch (err) {
      setVoiceState('idle');
      setItems((prev) => [...prev, { kind: 'notice', id: nextId(), tone: 'danger', text: `Voice setup failed: ${err instanceof Error ? err.message : String(err)}` }]);
    }
  }, [voiceState, getVoice, armVoice]);
  const armVoiceRef = useRef(armVoice);
  armVoiceRef.current = armVoice;

  useEffect(
    () => () => {
      voiceRef.current?.stop();
      abortRef.current?.abort();
    },
    [],
  );

  // Deferred agency: when a scheduled task comes due the scheduler runs a
  // full agent loop through this same path, so the user watches it think.
  useEffect(() => {
    scheduler.setRunner(async (instruction) => {
      for (let waited = 0; isRunBusy() && waited < 120_000; waited += 500) await new Promise((r) => setTimeout(r, 500));
      return run(instruction, 'scheduled');
    });
    scheduler.start();
    void scheduler.tick();
    return () => scheduler.setRunner(runAgentHeadless);
  }, [run]);

  const stop = useCallback(() => abortRef.current?.abort(), []);

  // Deep links: minimus://ask?q=<text> runs the request (Shortcuts, the
  // Action button, Back Tap, another app); minimus://ask?listen=1 opens the
  // mic straight away and speaks the answer, which is the "talk to Minimus"
  // Siri/Shortcut path. minimus://open just opens.
  useEffect(() => {
    let handledInitial = false;
    const handle = (url: string | null) => {
      if (!url) return;
      const m = /^minimus:\/\/ask\/?\?(.*)$/i.exec(url);
      if (!m) return;
      const params = new URLSearchParams(m[1]);
      const q = (params.get('q') ?? params.get('prompt') ?? '').trim();
      if (!q && params.get('listen')) {
        diag('deep link listen');
        // Speak the reply and hear one utterance without a wake phrase.
        void armVoiceRef.current('handsFree').catch((err) => {
          setVoiceState('idle');
          diag(`deep link listen failed: ${err instanceof Error ? err.message : String(err)}`);
        });
        return;
      }
      if (!q) return;
      diag(`deep link ask: ${JSON.stringify(q.slice(0, 80))}`);
      if (isRunBusy()) setInput(q);
      else void runRef.current(q, 'user');
    };
    void Linking.getInitialURL().then((url) => {
      if (!handledInitial) {
        handledInitial = true;
        handle(url);
      }
    });
    const sub = Linking.addEventListener('url', ({ url }) => handle(url));
    return () => sub.remove();
  }, []);

  // QA bridge handlers.
  useEffect(() => {
    const offAsk = registerQaHandler('ask', async (args) => {
      const prompt = String(args['prompt'] ?? '');
      const before = itemsRef.current.length;
      const started = Date.now();
      const finalText = await runRef.current(prompt, 'user');
      await new Promise((r) => setTimeout(r, 80));
      const added = itemsRef.current.slice(before).map((it) => {
        switch (it.kind) {
          case 'receipt':
            return { kind: 'receipt', ops: it.ops.map((o) => `${o.verb} → ${o.status}${o.result ? `: ${o.result}` : ''}`), footer: it.footer };
          case 'approval':
            return { kind: 'approval', title: it.title, resolved: it.resolved ?? 'pending' };
          case 'sources':
            return { kind: 'sources', count: it.sources.length };
          case 'live':
            return { kind: 'live' };
          default:
            return { kind: it.kind, text: it.text };
        }
      });
      return { finalText, seconds: (Date.now() - started) / 1000, added };
    });
    const offNew = registerQaHandler('newChat', async () => {
      useSessionStore.getState().newSession();
      return { ok: true };
    });
    const offApprove = registerQaHandler('approve', async (args) => {
      const pending = itemsRef.current.find((it) => it.kind === 'approval' && !it.resolved);
      if (!pending || pending.kind !== 'approval') return { resolved: false };
      pending.resolve(args['ok'] !== false);
      return { resolved: true, title: pending.title };
    });
    const offType = registerQaHandler('type', async (args) => {
      setInput(String(args['text'] ?? ''));
      return { ok: true };
    });
    return () => {
      offAsk();
      offNew();
      offApprove();
      offType();
    };
  }, []);

  // Clock pill: the soonest timer counts down in the header; otherwise the
  // next alarm. A finished timer also drops a line into the chat, so the
  // person looking at the phone sees it even with notifications off.
  const clockAlarms = useClockStore((s) => s.alarms);
  const clockTimers = useClockStore((s) => s.timers);
  const [clockNow, setClockNow] = useState(Date.now());
  const timersRunning = clockTimers.some((t) => t.state === 'running');
  useEffect(() => {
    if (!timersRunning) return;
    const t = setInterval(() => setClockNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [timersRunning]);
  useEffect(() => {
    const t = setInterval(() => void useClockStore.getState().sync(), 5000);
    return () => clearInterval(t);
  }, []);
  const announcedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const t of clockTimers) {
      if (t.state === 'done' && !announcedRef.current.has(t.id)) {
        announcedRef.current.add(t.id);
        setItems((prev) => [...prev, { kind: 'notice', id: nextId(), tone: 'muted', text: `⏱ ${t.label || 'Timer'} is done.` }]);
      }
    }
  }, [clockTimers]);
  const clockPill = useMemo(() => clockHeadline({ alarms: clockAlarms, timers: clockTimers }, clockNow), [clockAlarms, clockTimers, clockNow]);

  const engineLabel =
    remote.enabled && remote.baseUrl.trim() && remote.model.trim()
      ? `cloud · ${remote.model.trim()}`
      : engineState.status === 'ready'
        ? `${modelSpec?.name ?? activeModelId}${engineState.info.gpu ? ' · GPU' : ' · CPU'}`
        : engineState.status === 'loading'
          ? `loading ${Math.round(engineState.progress)}%`
          : engineState.status === 'error'
            ? 'model error'
            : 'model not loaded';

  const menu = useMemo(
    () =>
      [
        { label: 'New chat', hint: 'Start fresh', action: () => (running ? undefined : useSessionStore.getState().newSession()) },
        { label: 'Chats', hint: 'Earlier conversations', action: () => onOpen('history') },
        { label: 'Memory', hint: 'What it knows, taught phrases, scheduled', action: () => onOpen('memory') },
        { label: 'Clock', hint: 'Alarms, timers, stopwatch', action: () => onOpen('clock') },
        { label: 'Brain', hint: engineLabel, action: () => onOpen('brain') },
        { label: 'Tools', hint: 'What it may touch', action: () => onOpen('tools') },
        { label: 'Settings', hint: 'Voice, approvals, cloud', action: () => onOpen('settings') },
        { label: 'Diagnostics', hint: 'Checks, speed, logs', action: () => onOpen('diagnostics') },
      ] as const,
    [onOpen, engineLabel, running],
  );

  return (
    <KeyboardAvoidingView style={[styles.root, { backgroundColor: p.bg }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={[styles.header, { paddingTop: insets.top + space(2) }]}>
        <Pressable style={styles.brand} onPress={() => onOpen('brain')} accessibilityRole="button" accessibilityLabel="Brain">
          <Core state={coreState} size={30} />
          <View>
            <Text style={[styles.wordmark, { color: p.ink }]}>minimus</Text>
            <Text style={[styles.status, { color: engineState.status === 'error' ? p.danger : p.ink3 }]} numberOfLines={1}>
              {engineLabel}
            </Text>
          </View>
        </Pressable>
        <View style={styles.headerRight}>
          {clockPill ? (
            <Pressable onPress={() => onOpen('clock')} hitSlop={8} style={[styles.clockPill, { backgroundColor: clockPill.kind === 'timer' ? p.liveSoft : p.surface, borderColor: clockPill.kind === 'timer' ? p.live : p.line }]} accessibilityRole="button" accessibilityLabel="Clock">
              <Text style={[styles.clockPillText, { color: clockPill.kind === 'timer' ? p.live : p.ink2 }]}>{clockPill.kind === 'alarm' ? '⏰ ' : ''}{clockPill.text}</Text>
            </Pressable>
          ) : null}
          <Pressable onPress={() => onOpen('history')} hitSlop={8} style={[styles.headerBtn, { backgroundColor: p.surface, borderColor: p.line }]} accessibilityRole="button" accessibilityLabel="Chats">
            <GlyphClock color={p.ink2} size={15} />
          </Pressable>
          <Pressable onPress={() => !running && useSessionStore.getState().newSession()} hitSlop={8} style={[styles.headerBtn, { backgroundColor: p.surface, borderColor: p.line }]} accessibilityRole="button" accessibilityLabel="New chat">
            <GlyphPlus color={p.ink2} size={14} />
          </Pressable>
          <Pressable onPress={() => setMenuOpen(true)} hitSlop={8} style={[styles.headerBtn, { backgroundColor: p.surface, borderColor: p.line }]} accessibilityRole="button" accessibilityLabel="Menu">
            <GlyphMenu color={p.ink2} size={15} />
          </Pressable>
        </View>
      </View>

      {items.length === 0 ? (
        <EmptyState onPick={(s) => setInput(s)} />
      ) : (
        <FlatList
          ref={listRef}
          style={styles.list}
          data={items}
          keyExtractor={(it) => it.id}
          renderItem={({ item }) => <ItemView item={item} />}
          contentContainerStyle={styles.listContent}
          keyboardDismissMode="interactive"
          onContentSizeChange={() => running && scrollDown()}
        />
      )}

      <Composer
        value={input}
        onChange={setInput}
        onSend={() => void run(input)}
        onStop={stop}
        running={running}
        voiceState={voiceState}
        voiceDetail={voiceDetail}
        onMic={() => void onMic()}
        attachment={attachment?.name ?? null}
        toolsEnabled={toolsEnabled}
        onToggleTools={() => setToolsEnabled((v) => !v)}
        onAttach={() => void pickImage()}
        onClearAttachment={() => {
          setAttachment(null);
          setAttachedImage(null);
        }}
      />

      <Modal transparent visible={menuOpen} animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        <Pressable style={styles.sheetBackdrop} onPress={() => setMenuOpen(false)}>
          <View style={[styles.sheet, { backgroundColor: p.surface, paddingBottom: insets.bottom + space(4) }, elevation(p, 2)]}>
            <View style={[styles.grabber, { backgroundColor: p.lineStrong }]} />
            {menu.map((m) => (
              <Pressable
                key={m.label}
                style={({ pressed }) => [styles.sheetRow, pressed && { backgroundColor: p.surface2 }]}
                onPress={() => {
                  setMenuOpen(false);
                  m.action();
                }}
              >
                <Text style={[styles.sheetLabel, { color: p.ink }]}>{m.label}</Text>
                <Text style={[styles.sheetHint, { color: p.ink3 }]} numberOfLines={1}>
                  {m.hint}
                </Text>
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Modal>
    </KeyboardAvoidingView>
  );
}

function EmptyState({ onPick }: { onPick: (s: string) => void }): React.JSX.Element {
  const p = usePalette();
  const [open, setOpen] = useState<string | null>(null);
  return (
    <View style={styles.empty}>
      <Text style={[styles.greeting, { color: p.ink }]}>{greeting()}</Text>
      <Text style={[styles.emptyLine, { color: p.ink2 }]}>Your phone, doing things for you. Nothing leaves it.</Text>
      <View style={styles.grid}>
        {CAPABILITIES.map((c) => {
          const active = open === c.title;
          return (
            <Pressable
              key={c.title}
              onPress={() => setOpen(active ? null : c.title)}
              style={[styles.capCard, { backgroundColor: p.surface, borderColor: active ? p.ink : p.line }, elevation(p, 1)]}
            >
              <Text style={[styles.capTitle, { color: p.ink }]}>{c.title}</Text>
              <Text style={[styles.capBlurb, { color: p.ink2 }]}>{c.blurb}</Text>
            </Pressable>
          );
        })}
      </View>
      {open ? (
        <View style={styles.examples}>
          <Label>try</Label>
          {CAPABILITIES.find((c) => c.title === open)?.examples.map((e) => (
            <Pressable key={e} onPress={() => onPick(e)} style={[styles.example, { backgroundColor: p.surface2 }]}>
              <Text style={[styles.exampleText, { color: p.ink }]}>“{e}”</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const ItemView = React.memo(function ItemView({ item }: { item: Item }): React.JSX.Element | null {
  const p = usePalette();
  switch (item.kind) {
    case 'user':
      return (
        <View style={[styles.userCard, { backgroundColor: p.surface2 }]}>
          <Text style={[styles.userText, { color: p.ink }]}>{item.text}</Text>
        </View>
      );
    case 'scheduled':
      return (
        <View style={[styles.scheduledCard, { backgroundColor: p.accentSoft, borderColor: p.accent }]}>
          <Label tone="accent">scheduled · running now</Label>
          <Text style={[styles.scheduledText, { color: p.ink }]}>{item.text}</Text>
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
    case 'live':
      return (
        <View style={styles.agentBlock}>
          {item.reasoning || !item.thinkingDone ? (
            <ThinkingLine text={item.reasoning} seconds={(Date.now() - item.startedAt) / 1000} done={!!item.thinkingDone && item.text.length > 0} />
          ) : null}
          {item.text ? <AgentText text={item.text} live /> : null}
        </View>
      );
    case 'notice':
      return <Text style={[styles.notice, { color: item.tone === 'danger' ? p.danger : p.ink3 }]}>{item.text}</Text>;
    case 'sources':
      return (
        <FadeIn>
          <Sources sources={item.sources} />
        </FadeIn>
      );
    case 'receipt':
      return <Receipt ops={item.ops} footer={item.footer} />;
    case 'approval':
      if (item.resolved) {
        return <Text style={[styles.notice, { color: p.ink3 }]}>{item.resolved === 'yes' ? '✓ approved' : '— skipped'}</Text>;
      }
      return <ApprovalCard title={item.title} detail={item.detail} onDecision={item.resolve} />;
    default:
      return null;
  }
});

function FadeIn({ children }: { children: React.ReactNode }): React.JSX.Element {
  const opacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(opacity, { toValue: 1, duration: 240, useNativeDriver: true }).start();
  }, [opacity]);
  return <Animated.View style={{ opacity }}>{children}</Animated.View>;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space(4),
    paddingBottom: space(3),
  },
  brand: { flexDirection: 'row', alignItems: 'center', gap: space(3) },
  wordmark: { fontSize: 20, fontWeight: '800', letterSpacing: -0.6, lineHeight: 22 },
  status: { fontFamily: font.mono, fontSize: 10, letterSpacing: 0.4, marginTop: 1, maxWidth: 190 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: space(2) },
  clockPill: { height: 34, paddingHorizontal: space(3), borderRadius: 17, borderWidth: 1, justifyContent: 'center' },
  clockPillText: { fontFamily: font.mono, fontSize: 12, fontVariant: ['tabular-nums'] },
  headerBtn: { width: 34, height: 34, borderRadius: 17, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },

  list: { flex: 1 },
  listContent: { paddingHorizontal: space(4), paddingBottom: space(4), gap: space(3) },

  userCard: {
    alignSelf: 'flex-end',
    borderRadius: radius.lg,
    borderBottomRightRadius: radius.xs,
    paddingHorizontal: space(4),
    paddingVertical: space(3),
    maxWidth: '86%',
    marginTop: space(2),
  },
  userText: { fontSize: 16, lineHeight: 22, letterSpacing: -0.2 },
  scheduledCard: { alignSelf: 'flex-start', borderRadius: radius.md, borderWidth: 1, paddingHorizontal: space(3.5), paddingVertical: space(2.5), maxWidth: '92%', marginTop: space(2), gap: space(1) },
  scheduledText: { fontSize: 15, lineHeight: 21 },
  agentBlock: { marginTop: space(1), paddingRight: space(2) },
  notice: { fontSize: 13, fontFamily: font.mono, marginTop: space(1) },

  empty: { flex: 1, paddingHorizontal: space(5), paddingTop: space(6) },
  greeting: { fontSize: 34, fontWeight: '800', letterSpacing: -1.2, lineHeight: 38 },
  emptyLine: { fontSize: 16, lineHeight: 22, marginTop: space(2), marginBottom: space(6), letterSpacing: -0.2 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space(2.5) },
  capCard: { width: '48%', borderRadius: radius.lg, borderWidth: 1, padding: space(3.5), gap: 3, flexGrow: 1 },
  capTitle: { fontSize: 16, fontWeight: '700', letterSpacing: -0.3 },
  capBlurb: { fontSize: 12, lineHeight: 16 },
  examples: { marginTop: space(5), gap: space(2) },
  example: { borderRadius: radius.md, paddingHorizontal: space(3.5), paddingVertical: space(3) },
  exampleText: { fontSize: 14, lineHeight: 20 },

  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(20,16,8,0.45)', justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, paddingTop: space(2), paddingHorizontal: space(2) },
  grabber: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, marginBottom: space(2) },
  sheetRow: { paddingHorizontal: space(4), paddingVertical: space(3.5), borderRadius: radius.md, flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: space(3) },
  sheetLabel: { fontSize: 17, fontWeight: '600', letterSpacing: -0.3 },
  sheetHint: { fontSize: 12, fontFamily: font.mono, flexShrink: 1, textAlign: 'right' },
});
