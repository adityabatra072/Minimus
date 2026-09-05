import { NativeModules } from 'react-native';

/**
 * Diagnostics that survive a release build. React Native only pipes
 * console.* to the device console in dev, so on-device QA (idevicesyslog /
 * adb logcat) sees nothing from a sideloaded release app. The native module
 * forwards to NSLog / android.util.Log instead, and a ring buffer keeps the
 * recent lines for the QA bridge and the in-app diagnostics screen.
 */

const native = (
  NativeModules as Record<string, { log?: (message: string) => void } | undefined>
)['MinimusTools'];

const RING_SIZE = 600;
const ring: string[] = [];
const listeners = new Set<(line: string) => void>();

function stamp(): string {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export function diag(message: string): void {
  const line = `${stamp()} ${message}`;
  // eslint-disable-next-line no-console -- deliberate: dev console + device console
  console.log(`[minimus] ${message}`);
  ring.push(line);
  if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE);
  for (const l of listeners) l(line);
  try {
    native?.log?.(message);
  } catch {
    /* diagnostics must never break a run */
  }
}

export function recentDiag(count = 200): string[] {
  return ring.slice(-count);
}

export function onDiag(listener: (line: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
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
