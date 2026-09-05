import RNFS from 'react-native-fs';
import { NativeModules, Platform } from 'react-native';
import { captureScreen } from 'react-native-view-shot';
import { diag, recentDiag } from './diag';

/**
 * Remote QA bridge: lets a laptop drive the app on a real phone.
 *
 * iOS has no adb. Nothing can type into the app, tap it, or read its logs from
 * a Mac without Xcode attached, so on-device QA used to mean a human with a
 * thumb. This polls a tiny HTTP server on the laptop for commands ("ask the
 * agent X", "run the checks", "take a screenshot"), runs them through the same
 * code paths a tap would, and posts the results back.
 *
 * It is OFF unless enabled: by a Metro dev server (debug builds), or by a file
 * `qa-host.txt` in the app's Documents folder containing `host:port`, which
 * `xcrun devicectl device copy to` can drop there over USB. Release builds
 * shipped to users never poll anything.
 */

export type QaHandler = (args: Record<string, unknown>) => Promise<unknown>;

const handlers = new Map<string, QaHandler>();
let host: string | null = null;
let polling = false;
let deviceName: string = Platform.OS;

export function registerQaHandler(name: string, handler: QaHandler): () => void {
  handlers.set(name, handler);
  return () => {
    if (handlers.get(name) === handler) handlers.delete(name);
  };
}

async function discoverHost(): Promise<string | null> {
  const file = `${RNFS.DocumentDirectoryPath}/qa-host.txt`;
  if (await RNFS.exists(file)) {
    const text = (await RNFS.readFile(file, 'utf8')).trim();
    if (text) return text;
  }
  if (__DEV__) {
    // Debug builds already talk to Metro; the QA server lives next to it.
    const scriptUrl: string | undefined = (NativeModules as Record<string, { scriptURL?: string }>)['SourceCode']?.scriptURL;
    const m = scriptUrl ? /^https?:\/\/([^/:]+)/.exec(scriptUrl) : null;
    if (m && m[1] && m[1] !== 'localhost' && m[1] !== '127.0.0.1') return `${m[1]}:8787`;
    // A debug build running its embedded bundle (Metro unreachable) still
    // carries the Mac's address in ip.txt, written by the RN build phase.
    const ipFile = `${RNFS.MainBundlePath}/ip.txt`;
    if (await RNFS.exists(ipFile)) {
      const ip = (await RNFS.readFile(ipFile, 'utf8')).trim();
      if (ip) return `${ip}:8787`;
    }
  }
  return null;
}

async function post(path: string, body: unknown): Promise<void> {
  await fetch(`http://${host}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function runCommand(cmd: { id: string; name: string; args?: Record<string, unknown> }): Promise<void> {
  const started = Date.now();
  try {
    let data: unknown;
    if (cmd.name === 'screenshot') {
      const uri = await captureScreen({ format: 'jpg', quality: 0.8, result: 'base64' });
      data = { jpegBase64: uri };
    } else if (cmd.name === 'logs') {
      data = { lines: recentDiag(Number(cmd.args?.['count'] ?? 200)) };
    } else if (cmd.name === 'ping') {
      data = { ok: true, handlers: [...handlers.keys()], device: deviceName };
    } else {
      const handler = handlers.get(cmd.name);
      if (!handler) throw new Error(`no handler for ${cmd.name}; have ${[...handlers.keys()].join(', ')}`);
      data = await handler(cmd.args ?? {});
    }
    await post(`/result/${cmd.id}`, { ok: true, data, ms: Date.now() - started });
  } catch (err) {
    await post(`/result/${cmd.id}`, {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      ms: Date.now() - started,
    });
  }
}

async function pollOnce(): Promise<void> {
  const res = await fetch(`http://${host}/poll?device=${encodeURIComponent(deviceName)}`);
  if (res.status !== 200) return;
  const cmd = (await res.json()) as { id: string; name: string; args?: Record<string, unknown> } | null;
  if (cmd && cmd.id) {
    diag(`qa: ${cmd.name} ${JSON.stringify(cmd.args ?? {}).slice(0, 120)}`);
    // Commands may take minutes (an agent run). Do not block polling on them;
    // the server hands out one command at a time per device anyway.
    void runCommand(cmd);
  }
}

export async function startQaBridge(): Promise<void> {
  if (polling) return;
  host = await discoverHost().catch(() => null);
  if (!host) return;
  polling = true;
  try {
    const DeviceInfo = (require('react-native-device-info') as { default: { getDeviceName: () => Promise<string> } }).default;
    deviceName = await DeviceInfo.getDeviceName();
  } catch {
    /* keep the platform name */
  }
  diag(`qa bridge: polling ${host}`);
  let failures = 0;
  const loop = async () => {
    while (polling) {
      try {
        await pollOnce();
        failures = 0;
      } catch {
        failures++;
      }
      // Back off when the laptop is gone; keep it snappy when it is there.
      await new Promise((r) => setTimeout(r, failures > 5 ? 5000 : 700));
    }
  };
  void loop();
}

export function qaBridgeActive(): boolean {
  return polling;
}
