import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DEFAULT_MODEL_ID } from '../services/catalog';

/** Active-model selection, persisted across launches. */

interface ModelState {
  activeModelId: string;
  setActiveModel: (id: string) => void;
  hydrate: () => Promise<void>;
}

const KEY = 'minimus.activeModelId';

export const useModelStore = create<ModelState>((set) => ({
  activeModelId: DEFAULT_MODEL_ID,
  setActiveModel: (id: string) => {
    set({ activeModelId: id });
    AsyncStorage.setItem(KEY, id).catch(() => undefined);
  },
  hydrate: async () => {
    const saved = await AsyncStorage.getItem(KEY).catch(() => null);
    if (saved) set({ activeModelId: saved });
  },
}));
