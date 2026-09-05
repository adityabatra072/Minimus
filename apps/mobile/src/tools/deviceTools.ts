import { Linking, NativeModules, Platform } from 'react-native';
import DeviceInfo from 'react-native-device-info';
import type { ToolDefinition } from '@minimus/agent-core';

/**
 * Device tools. Pure-RN implementations where possible; flashlight/brightness
 * and friends call the MinimusTools native module (Kotlin/Swift), which lands
 * in the platform-tools milestone — until then they throw a clear error.
 */

interface MinimusToolsModule {
  setTorch(on: boolean): Promise<void>;
  setBrightness(level: number): Promise<void>;
  clipboardRead?(): Promise<string>;
  clipboardWrite?(text: string): Promise<void>;
}

function nativeTools(): MinimusToolsModule | null {
  return (NativeModules as Record<string, MinimusToolsModule | undefined>)['MinimusTools'] ?? null;
}

/** Curated app registry: name → per-platform open strategy. */
const APP_REGISTRY: Record<string, { ios: string; android: string }> = {
  spotify: { ios: 'spotify:', android: 'spotify:' },
  settings: { ios: 'app-settings:', android: 'minimus-intent://settings' },
  camera: { ios: 'camera:', android: 'minimus-intent://camera' },
  maps: { ios: 'maps:', android: 'geo:0,0' },
  youtube: { ios: 'youtube:', android: 'vnd.youtube:' },
  whatsapp: { ios: 'whatsapp:', android: 'whatsapp:' },
  chrome: { ios: 'googlechrome:', android: 'googlechrome:' },
  safari: { ios: 'https://www.apple.com', android: 'https://www.google.com' },
  mail: { ios: 'message:', android: 'mailto:' },
  photos: { ios: 'photos-redirect:', android: 'content://media/external/images' },
};

export function deviceTools(): ToolDefinition[] {
  return [
    {
      name: 'flashlight',
      kind: 'action',
      group: 'device',
      description: 'Turn the phone flashlight (torch) on or off',
      parameters: {
        type: 'object',
        properties: { on: { type: 'boolean', description: 'true to turn on, false to turn off' } },
        required: ['on'],
      },
      execute: async (args) => {
        const native = nativeTools();
        if (!native) throw new Error('flashlight native module not installed yet');
        await native.setTorch(Boolean(args['on']));
        return { ok: true, state: args['on'] ? 'on' : 'off' };
      },
    },
    {
      name: 'set_brightness',
      kind: 'action',
      group: 'device',
      description: 'Set screen brightness',
      parameters: {
        type: 'object',
        properties: { level: { type: 'number', description: '0.0 (dim) to 1.0 (max)' } },
        required: ['level'],
      },
      execute: async (args) => {
        const native = nativeTools();
        if (!native) throw new Error('brightness native module not installed yet');
        const level = Math.max(0, Math.min(1, Number(args['level'])));
        await native.setBrightness(level);
        return { ok: true, level };
      },
    },
    {
      name: 'device_info',
      group: 'device',
      description: 'Get battery level, network status and free storage',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        const [battery, charging, freeDisk] = await Promise.all([
          DeviceInfo.getBatteryLevel(),
          DeviceInfo.isBatteryCharging(),
          DeviceInfo.getFreeDiskStorage(),
        ]);
        return {
          battery_percent: Math.round(battery * 100),
          charging,
          storage_free_gb: Math.round((freeDisk / 1e9) * 10) / 10,
          platform: Platform.OS,
        };
      },
    },
    {
      name: 'open_app',
      kind: 'action',
      group: 'device',
      description: 'Open another app on the phone by name',
      parameters: {
        type: 'object',
        properties: {
          app: { type: 'string', description: 'app name, e.g. "spotify", "settings", "camera"' },
        },
        required: ['app'],
      },
      execute: async (args) => {
        const name = String(args['app']).toLowerCase().trim();
        const entry = APP_REGISTRY[name];
        const url = entry ? entry[Platform.OS === 'ios' ? 'ios' : 'android'] : `${name}:`;
        const can = await Linking.canOpenURL(url).catch(() => false);
        if (!can && !entry) {
          throw new Error(
            `Cannot open "${name}" — not in the app registry and no "${name}:" URL scheme responded.`,
          );
        }
        await Linking.openURL(url);
        return { ok: true, opened: name };
      },
    },
    {
      name: 'open_url',
      group: 'device',
      kind: 'action',
      description: 'Open a web address in the browser, or a maps search like "maps:coffee near me"',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'https://… link, or "maps:<place or query>" to open Maps' } },
        required: ['url'],
      },
      execute: async (args) => {
        let url = String(args['url']).trim();
        if (/^maps:/i.test(url)) {
          url = `maps://?q=${encodeURIComponent(url.replace(/^maps:/i, '').trim())}`;
        } else if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) {
          url = `https://${url}`;
        }
        await Linking.openURL(url);
        return { ok: true, opened: url };
      },
    },
    {
      name: 'clipboard_read',
      group: 'device',
      description: 'Read the text currently on the clipboard',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        const native = nativeTools();
        if (!native?.clipboardRead) throw new Error('clipboard not available');
        const text = await native.clipboardRead();
        return { text: text.slice(0, 4000), empty: text.trim() === '' };
      },
    },
    {
      name: 'clipboard_write',
      group: 'device',
      kind: 'action',
      description: 'Put text on the clipboard',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      execute: async (args) => {
        const native = nativeTools();
        if (!native?.clipboardWrite) throw new Error('clipboard not available');
        await native.clipboardWrite(String(args['text']));
        return { ok: true, chars: String(args['text']).length };
      },
    },
  ];
}
