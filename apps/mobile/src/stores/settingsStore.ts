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
  hydrate: () => Promise<void>;
  setRemote: (patch: Partial<RemoteEndpoint>) => void;
  setRequireApprovals: (on: boolean) => void;
}

const KEY = 'minimus.settings.v1';

function persist(state: Pick<SettingsState, 'remote' | 'requireApprovals'>) {
  AsyncStorage.setItem(
    KEY,
    JSON.stringify({ remote: state.remote, requireApprovals: state.requireApprovals }),
  ).catch(() => undefined);
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  remote: { enabled: false, baseUrl: '', apiKey: '', model: '' },
  requireApprovals: true,

  hydrate: async () => {
    const raw = await AsyncStorage.getItem(KEY).catch(() => null);
    if (!raw) return;
    try {
      const saved = JSON.parse(raw) as Partial<
        Pick<SettingsState, 'remote' | 'requireApprovals'>
      >;
      set({
        ...(saved.remote ? { remote: { ...get().remote, ...saved.remote } } : {}),
        ...(saved.requireApprovals !== undefined
          ? { requireApprovals: saved.requireApprovals }
          : {}),
      });
    } catch {
      /* corrupt settings — keep defaults */
    }
  },

  setRemote: (patch: Partial<RemoteEndpoint>) => {
    const remote = { ...get().remote, ...patch };
    set({ remote });
    persist({ remote, requireApprovals: get().requireApprovals });
  },

  setRequireApprovals: (on: boolean) => {
    set({ requireApprovals: on });
    persist({ remote: get().remote, requireApprovals: on });
  },
}));
