import { NativeModules } from 'react-native';

/**
 * Diagnostics that survive a release build. React Native only pipes
 * console.* to the device console in dev, so on-device QA (idevicesyslog /
 * adb logcat) sees nothing from a sideloaded release app. The native module
 * forwards to NSLog / android.util.Log instead.
 */

const native = (
  NativeModules as Record<string, { log?: (message: string) => void } | undefined>
)['MinimusTools'];

export function diag(message: string): void {
  // eslint-disable-next-line no-console -- deliberate: dev console + device console
  console.log(`[minimus] ${message}`);
  try {
    native?.log?.(message);
  } catch {
    /* diagnostics must never break a run */
  }
}

/** Times an async step and logs how long it took. */
export async function timed<T>(label: string, work: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    return await work();
  } finally {
    diag(`${label} took ${((Date.now() - started) / 1000).toFixed(1)}s`);
  }
}
