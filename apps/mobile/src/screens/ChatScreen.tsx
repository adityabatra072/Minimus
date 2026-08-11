import React, { useCallback, useRef, useState } from 'react';
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { AgentLoop, type AgentEvent, type ToolCall } from '@minimus/agent-core';
import { LocalAdapter } from '../services/LocalAdapter';
import { buildToolRegistry } from '../tools';
import { DEFAULT_MODEL_ID } from '../services/catalog';

/**
 * Milestone-2 chat screen: streaming text, reasoning collapse, tool-call
 * chips with live status, approval prompts. Deliberately styling-light —
 * polish comes after the loop is proven on-device.
 */

type Bubble =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string; thinking?: string; streaming: boolean }
  | { kind: 'tool'; id: string; call: ToolCall; status: 'running' | 'ok' | 'error' | 'denied'; result?: string };

let bubbleId = 0;
const nextId = () => `b${++bubbleId}`;

const registry = buildToolRegistry();

export default function ChatScreen(): React.JSX.Element {
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<FlatList<Bubble>>(null);

  const askApproval = useCallback((call: ToolCall): Promise<boolean> => {
    return new Promise((resolve) => {
      Alert.alert(
        `Allow ${call.name}?`,
        JSON.stringify(call.arguments, null, 2),
        [
          { text: 'Deny', style: 'cancel', onPress: () => resolve(false) },
          { text: 'Allow', onPress: () => resolve(true) },
        ],
        { cancelable: false },
      );
    });
  }, []);

  const send = useCallback(async () => {
    const prompt = input.trim();
    if (!prompt || running) return;
    setInput('');
    setRunning(true);
    const abort = new AbortController();
    abortRef.current = abort;

    setBubbles((prev) => [...prev, { kind: 'user', id: nextId(), text: prompt }]);

    const adapter = new LocalAdapter(DEFAULT_MODEL_ID);
    const loop = new AgentLoop();

    let currentAssistantId: string | null = null;
    const update = (fn: (prev: Bubble[]) => Bubble[]) => {
      setBubbles(fn);
      requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
    };

    try {
      const events = loop.run(prompt, {
        adapter,
        tools: registry,
        approvals: (req) => askApproval(req.call),
        signal: abort.signal,
      });
      for await (const ev of events) {
        handleEvent(ev);
      }
    } catch (err) {
      update((prev) => [
        ...prev,
        {
          kind: 'assistant',
          id: nextId(),
          text: `Something broke: ${err instanceof Error ? err.message : String(err)}`,
          streaming: false,
        },
      ]);
    } finally {
      setRunning(false);
      abortRef.current = null;
    }

    function handleEvent(ev: AgentEvent) {
      switch (ev.type) {
        case 'turn_started':
          currentAssistantId = null;
          break;
        case 'text_delta': {
          if (currentAssistantId === null) {
            const id = nextId();
            currentAssistantId = id;
            update((prev) => [...prev, { kind: 'assistant', id, text: ev.text, streaming: true }]);
          } else {
            update((prev) =>
              prev.map((b) =>
                b.id === currentAssistantId && b.kind === 'assistant'
                  ? { ...b, text: b.text + ev.text }
                  : b,
              ),
            );
          }
          break;
        }
        case 'tool_call_started':
          update((prev) => [
            ...prev,
            { kind: 'tool', id: `t_${ev.call.id}`, call: ev.call, status: 'running' },
          ]);
          break;
        case 'tool_call_finished':
          update((prev) => {
            const existing = prev.some((b) => b.id === `t_${ev.call.id}`);
            const bubble: Bubble = {
              kind: 'tool',
              id: `t_${ev.call.id}`,
              call: ev.call,
              status: ev.isError ? 'error' : 'ok',
              result: ev.result.slice(0, 400),
            };
            return existing
              ? prev.map((b) => (b.id === `t_${ev.call.id}` ? bubble : b))
              : [...prev, bubble];
          });
          break;
        case 'approval_resolved':
          if (!ev.approved) {
            update((prev) => [
              ...prev,
              { kind: 'tool', id: `t_${ev.call.id}`, call: ev.call, status: 'denied' },
            ]);
          }
          break;
        case 'run_finished': {
          if (currentAssistantId !== null) {
            update((prev) =>
              prev.map((b) =>
                b.id === currentAssistantId && b.kind === 'assistant'
                  ? { ...b, text: ev.finalText || b.text, streaming: false }
                  : b,
              ),
            );
          } else if (ev.finalText) {
            update((prev) => [
              ...prev,
              { kind: 'assistant', id: nextId(), text: ev.finalText, streaming: false },
            ]);
          }
          if (ev.reason === 'error' && ev.error) {
            update((prev) => [
              ...prev,
              { kind: 'assistant', id: nextId(), text: `⚠️ ${ev.error}`, streaming: false },
            ]);
          }
          break;
        }
        default:
          break;
      }
    }
  }, [input, running, askApproval]);

  const stop = useCallback(() => abortRef.current?.abort(), []);

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <FlatList
        ref={listRef}
        style={styles.list}
        data={bubbles}
        keyExtractor={(b) => b.id}
        renderItem={({ item }) => <BubbleView bubble={item} />}
        contentContainerStyle={styles.listContent}
      />
      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder="Ask me to do something…"
          placeholderTextColor="#888"
          editable={!running}
          onSubmitEditing={send}
          returnKeyType="send"
        />
        {running ? (
          <TouchableOpacity style={[styles.sendBtn, styles.stopBtn]} onPress={stop}>
            <Text style={styles.sendText}>Stop</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity style={styles.sendBtn} onPress={send}>
            <Text style={styles.sendText}>Send</Text>
          </TouchableOpacity>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

function BubbleView({ bubble }: { bubble: Bubble }): React.JSX.Element {
  switch (bubble.kind) {
    case 'user':
      return (
        <View style={[styles.bubble, styles.userBubble]}>
          <Text style={styles.userText}>{bubble.text}</Text>
        </View>
      );
    case 'assistant':
      return (
        <View style={[styles.bubble, styles.assistantBubble]}>
          <Text style={styles.assistantText}>
            {bubble.text || (bubble.streaming ? '…' : '')}
          </Text>
        </View>
      );
    case 'tool': {
      const icon =
        bubble.status === 'running'
          ? '⏳'
          : bubble.status === 'ok'
            ? '✅'
            : bubble.status === 'denied'
              ? '🚫'
              : '❌';
      return (
        <View style={[styles.bubble, styles.toolBubble]}>
          <Text style={styles.toolTitle}>
            {icon} {bubble.call.name}({JSON.stringify(bubble.call.arguments)})
          </Text>
          {bubble.result ? <Text style={styles.toolResult}>{bubble.result}</Text> : null}
        </View>
      );
    }
  }
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0e0e12' },
  list: { flex: 1 },
  listContent: { padding: 12, gap: 8 },
  bubble: { borderRadius: 14, padding: 12, maxWidth: '92%' },
  userBubble: { backgroundColor: '#2563eb', alignSelf: 'flex-end' },
  userText: { color: 'white', fontSize: 15 },
  assistantBubble: { backgroundColor: '#1d1d26', alignSelf: 'flex-start' },
  assistantText: { color: '#eee', fontSize: 15 },
  toolBubble: { backgroundColor: '#14141c', alignSelf: 'flex-start', borderWidth: 1, borderColor: '#2a2a38' },
  toolTitle: { color: '#9ecbff', fontSize: 12, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  toolResult: { color: '#7a7a8c', fontSize: 11, marginTop: 6, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  inputRow: { flexDirection: 'row', padding: 10, gap: 8, backgroundColor: '#14141c' },
  input: { flex: 1, backgroundColor: '#1d1d26', borderRadius: 10, paddingHorizontal: 12, color: 'white', height: 44 },
  sendBtn: { backgroundColor: '#2563eb', borderRadius: 10, paddingHorizontal: 18, justifyContent: 'center' },
  stopBtn: { backgroundColor: '#dc2626' },
  sendText: { color: 'white', fontWeight: '600' },
});
