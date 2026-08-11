import { NativeModules, Platform } from 'react-native';

/** Floating-bubble overlay control (Android; iOS has no overlay equivalent). */

interface OverlayNative {
  hasOverlayPermission(): Promise<boolean>;
  requestOverlayPermission(): Promise<void>;
  setOverlayEnabled(enabled: boolean): Promise<void>;
}

function native(): OverlayNative | null {
  if (Platform.OS !== 'android') return null;
  return (NativeModules as Record<string, OverlayNative | undefined>)['MinimusTools'] ?? null;
}

export const overlay = {
  available: (): boolean => native() !== null,

  /** Returns true when the bubble is up; false when permission is pending. */
  async enable(): Promise<boolean> {
    const mod = native();
    if (!mod) return false;
    if (!(await mod.hasOverlayPermission())) {
      await mod.requestOverlayPermission();
      return false; // user is in system settings; call enable() again after
    }
    await mod.setOverlayEnabled(true);
    return true;
  },

  async disable(): Promise<void> {
    await native()?.setOverlayEnabled(false);
  },

  async hasPermission(): Promise<boolean> {
    const mod = native();
    return mod ? mod.hasOverlayPermission() : false;
  },
};
