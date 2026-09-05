import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * App settings, persisted. The remote endpoint block is the on-ramp for
 * hybrid routing: any OpenAI-compatible server. Voice has its own knobs: the
 * system voice to speak with, the speaking rate, and optional cloud endpoints
 * for transcription and speech (also OpenAI-compatible).
 */

export interface RemoteEndpoint {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface VoiceSettings {
  /** System voice identifier ('' = best installed English voice). */
  systemVoiceId: string;
  /** Speaking rate multiplier (1 = system default). */
  rate: number;
  /** Repair transcripts with the language model. */
  llmCorrection: boolean;
  remoteStt: { enabled: boolean; baseUrl: string; apiKey: string; model: string };
  remoteTts: { enabled: boolean; baseUrl: string; apiKey: string; model: string; voice: string };
}

interface SettingsState {
  remote: RemoteEndpoint;
  /** Approval prompts for side-effecting tools (email/SMS/call). */
  requireApprovals: boolean;
  /** Hands-free voice: re-arm the mic after each turn, gated by "Minimus". */
  voiceHandsFree: boolean;
  voice: VoiceSettings;
  /** Time of day for the daily brief, "HH:MM", or '' when off. */
  briefTime: string;
  hydrate: () => Promise<void>;
  setRemote: (patch: Partial<RemoteEndpoint>) => void;
  setRequireApprovals: (on: boolean) => void;
  setVoiceHandsFree: (on: boolean) => void;
  setVoice: (patch: Partial<VoiceSettings>) => void;
  setBriefTime: (t: string) => void;
}

const KEY = 'minimus.settings.v2';

const DEFAULT_VOICE: VoiceSettings = {
  systemVoiceId: '',
  rate: 1,
  llmCorrection: true,
  remoteStt: { enabled: false, baseUrl: '', apiKey: '', model: 'whisper-1' },
  remoteTts: { enabled: false, baseUrl: '', apiKey: '', model: 'tts-1', voice: 'alloy' },
};

type Persisted = Pick<SettingsState, 'remote' | 'requireApprovals' | 'voiceHandsFree' | 'voice' | 'briefTime'>;

function persist(state: Persisted) {
  AsyncStorage.setItem(
    KEY,
    JSON.stringify({
      remote: state.remote,
      requireApprovals: state.requireApprovals,
      voiceHandsFree: state.voiceHandsFree,
      voice: state.voice,
      briefTime: state.briefTime,
    }),
  ).catch(() => undefined);
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  remote: { enabled: false, baseUrl: '', apiKey: '', model: '' },
  requireApprovals: true,
  voiceHandsFree: false,
  voice: DEFAULT_VOICE,
  briefTime: '',

  hydrate: async () => {
    const raw = (await AsyncStorage.getItem(KEY).catch(() => null)) ?? (await AsyncStorage.getItem('minimus.settings.v1').catch(() => null));
    if (!raw) return;
    try {
      const saved = JSON.parse(raw) as Partial<Persisted>;
      set({
        ...(saved.remote ? { remote: { ...get().remote, ...saved.remote } } : {}),
        ...(saved.requireApprovals !== undefined ? { requireApprovals: saved.requireApprovals } : {}),
        ...(saved.voiceHandsFree !== undefined ? { voiceHandsFree: saved.voiceHandsFree } : {}),
        ...(saved.voice
          ? {
              voice: {
                ...DEFAULT_VOICE,
                ...saved.voice,
                remoteStt: { ...DEFAULT_VOICE.remoteStt, ...(saved.voice.remoteStt ?? {}) },
                remoteTts: { ...DEFAULT_VOICE.remoteTts, ...(saved.voice.remoteTts ?? {}) },
              },
            }
          : {}),
        ...(saved.briefTime !== undefined ? { briefTime: saved.briefTime } : {}),
      });
    } catch {
      /* corrupt settings — keep defaults */
    }
  },

  setRemote: (patch) => {
    const remote = { ...get().remote, ...patch };
    set({ remote });
    persist({ ...get(), remote });
  },
  setRequireApprovals: (on) => {
    set({ requireApprovals: on });
    persist({ ...get(), requireApprovals: on });
  },
  setVoiceHandsFree: (on) => {
    set({ voiceHandsFree: on });
    persist({ ...get(), voiceHandsFree: on });
  },
  setVoice: (patch) => {
    const voice = { ...get().voice, ...patch };
    set({ voice });
    persist({ ...get(), voice });
  },
  setBriefTime: (briefTime) => {
    set({ briefTime });
    persist({ ...get(), briefTime });
  },
}));
