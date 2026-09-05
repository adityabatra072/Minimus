import { NativeModules } from 'react-native';

/** Thermal state and memory footprint from the native side (iOS). */
export interface DeviceHealth {
  thermal: 'nominal' | 'fair' | 'serious' | 'critical' | 'unknown';
  lowPowerMode: boolean;
  footprintBytes: number;
  availableBytes: number;
}

export async function deviceHealth(): Promise<DeviceHealth> {
  const mod = (NativeModules as Record<string, { deviceHealth?: () => Promise<DeviceHealth> } | undefined>)['MinimusTools'];
  if (!mod?.deviceHealth) return { thermal: 'unknown', lowPowerMode: false, footprintBytes: -1, availableBytes: -1 };
  try {
    return await mod.deviceHealth();
  } catch {
    return { thermal: 'unknown', lowPowerMode: false, footprintBytes: -1, availableBytes: -1 };
  }
}

export function healthLine(h: DeviceHealth): string {
  const mb = (n: number) => (n >= 0 ? `${Math.round(n / 1e6)} MB` : '?');
  return `thermal ${h.thermal}${h.lowPowerMode ? ' · low power' : ''} · app ${mb(h.footprintBytes)} · headroom ${mb(h.availableBytes)}`;
}
