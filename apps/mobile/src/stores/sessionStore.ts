import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Chat sessions, persisted across launches. A session is the durable record
 * of one conversation: its transcript items (the same renderable shapes the
 * chat screen uses, minus non-serializable fields) plus metadata for the
 * history list. The ACTIVE session is written through on every change so a
 * force-quit never loses a conversation.
 */

export interface SessionMessage {
  kind: 'user' | 'scheduled' | 'agent' | 'sources' | 'rail-summary';
  text: string;
  /** For 'sources' rows: JSON of {title,url}[] — kept flat for storage. */
  data?: string;
  atMs: number;
}

export interface SessionMeta {
  id: string;
  /** First user prompt, trimmed — the history row label. */
  title: string;
  createdAtMs: number;
  updatedAtMs: number;
  messageCount: number;
}

interface SessionState {
  sessions: SessionMeta[];
  activeSessionId: string;
  hydrate: () => Promise<void>;
  newSession: () => string;
  /** Switch to a saved conversation and remember it across launches. */
  openSession: (id: string) => void;
  deleteSession: (id: string) => void;
  /** Append messages to the active session and persist. */
  appendToActive: (messages: SessionMessage[]) => void;
  loadTranscript: (id: string) => Promise<SessionMessage[]>;
}

const INDEX_KEY = 'minimus.sessions.index';
const ACTIVE_KEY = 'minimus.sessions.active';
const transcriptKey = (id: string) => `minimus.sessions.${id}`;
const MAX_SESSIONS = 50;

const newId = () => `s${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;

async function saveIndex(sessions: SessionMeta[]) {
  await AsyncStorage.setItem(INDEX_KEY, JSON.stringify(sessions)).catch(() => undefined);
}

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: [],
  activeSessionId: newId(),

  hydrate: async () => {
    const raw = await AsyncStorage.getItem(INDEX_KEY).catch(() => null);
    if (raw) {
      try {
        set({ sessions: JSON.parse(raw) as SessionMeta[] });
      } catch {
        /* corrupt index — start fresh, transcripts stay recoverable by key */
      }
    }
    // Reopen the conversation the user was last in. Without this every launch
    // landed on an empty chat and the previous one could only be found through
    // the history screen, which reads as "the app forgot".
    const active = await AsyncStorage.getItem(ACTIVE_KEY).catch(() => null);
    if (active && get().sessions.some((s) => s.id === active)) {
      set({ activeSessionId: active });
    }
  },

  newSession: () => {
    const id = newId();
    set({ activeSessionId: id });
    AsyncStorage.setItem(ACTIVE_KEY, id).catch(() => undefined);
    return id;
  },

  openSession: (id: string) => {
    set({ activeSessionId: id });
    AsyncStorage.setItem(ACTIVE_KEY, id).catch(() => undefined);
  },

  deleteSession: (id: string) => {
    const sessions = get().sessions.filter((s) => s.id !== id);
    set({ sessions });
    void saveIndex(sessions);
    AsyncStorage.removeItem(transcriptKey(id)).catch(() => undefined);
  },

  appendToActive: (messages: SessionMessage[]) => {
    if (messages.length === 0) return;
    const { activeSessionId, sessions } = get();
    const existing = sessions.find((s) => s.id === activeSessionId);
    const firstUser = messages.find((m) => m.kind === 'user');
    const meta: SessionMeta = existing
      ? { ...existing, updatedAtMs: Date.now(), messageCount: existing.messageCount + messages.length }
      : {
          id: activeSessionId,
          title: (firstUser?.text ?? 'New chat').slice(0, 60),
          createdAtMs: Date.now(),
          updatedAtMs: Date.now(),
          messageCount: messages.length,
        };
    const rest = sessions.filter((s) => s.id !== activeSessionId);
    // Newest first; cap the index and drop the oldest transcript with it.
    const next = [meta, ...rest].slice(0, MAX_SESSIONS);
    for (const evicted of [meta, ...rest].slice(MAX_SESSIONS)) {
      AsyncStorage.removeItem(transcriptKey(evicted.id)).catch(() => undefined);
    }
    set({ sessions: next });
    void saveIndex(next);
    AsyncStorage.setItem(ACTIVE_KEY, activeSessionId).catch(() => undefined);
    void (async () => {
      const raw = await AsyncStorage.getItem(transcriptKey(activeSessionId)).catch(() => null);
      let transcript: SessionMessage[] = [];
      if (raw) {
        try {
          transcript = JSON.parse(raw) as SessionMessage[];
        } catch {
          transcript = [];
        }
      }
      transcript.push(...messages);
      await AsyncStorage.setItem(transcriptKey(activeSessionId), JSON.stringify(transcript)).catch(
        () => undefined,
      );
    })();
  },

  loadTranscript: async (id: string) => {
    const raw = await AsyncStorage.getItem(transcriptKey(id)).catch(() => null);
    if (!raw) return [];
    try {
      return JSON.parse(raw) as SessionMessage[];
    } catch {
      return [];
    }
  },
}));
