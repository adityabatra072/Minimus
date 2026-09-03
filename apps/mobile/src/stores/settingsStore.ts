import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * App settings, persisted. The remote endpoint block is the on-ramp for
 * hybrid routing: any OpenAI-compatible server (rcli serve, the Python SDK
 * server, a cloud key). Nothing here changes agent behavior until routing
 * consults it — settings are stored truthfully or not at all.
 */

export interface RemoteEndpoint {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
}

interface SettingsState {
  remote: RemoteEndpoint;
  /** Approval prompts for side-effecting tools (email/SMS/call). */
  requireApprovals: boolean;
  /** Hands-free voice: re-arm the mic after each turn, gated by "Minimus". */
  voiceHandsFree: boolean;
  hydrate: () => Promise<void>;
  setRemote: (patch: Partial<RemoteEndpoint>) => void;
  setRequireApprovals: (on: boolean) => void;
  setVoiceHandsFree: (on: boolean) => void;
}

const KEY = 'minimus.settings.v1';

type Persisted = Pick<SettingsState, 'remote' | 'requireApprovals' | 'voiceHandsFree'>;

function persist(state: Persisted) {
  AsyncStorage.setItem(
    KEY,
    JSON.stringify({
      remote: state.remote,
      requireApprovals: state.requireApprovals,
      voiceHandsFree: state.voiceHandsFree,
    }),
  ).catch(() => undefined);
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  remote: { enabled: false, baseUrl: '', apiKey: '', model: '' },
  requireApprovals: true,
  voiceHandsFree: false,

  hydrate: async () => {
    const raw = await AsyncStorage.getItem(KEY).catch(() => null);
    if (!raw) return;
    try {
      const saved = JSON.parse(raw) as Partial<Persisted>;
      set({
        ...(saved.remote ? { remote: { ...get().remote, ...saved.remote } } : {}),
        ...(saved.requireApprovals !== undefined
          ? { requireApprovals: saved.requireApprovals }
          : {}),
        ...(saved.voiceHandsFree !== undefined ? { voiceHandsFree: saved.voiceHandsFree } : {}),
      });
    } catch {
      /* corrupt settings — keep defaults */
    }
  },

  setRemote: (patch: Partial<RemoteEndpoint>) => {
    const remote = { ...get().remote, ...patch };
    set({ remote });
    persist({ ...get(), remote });
  },

  setRequireApprovals: (on: boolean) => {
    set({ requireApprovals: on });
    persist({ ...get(), requireApprovals: on });
  },

  setVoiceHandsFree: (on: boolean) => {
    set({ voiceHandsFree: on });
    persist({ ...get(), voiceHandsFree: on });
  },
}));
