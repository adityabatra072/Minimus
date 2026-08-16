import { PermissionsAndroid, Platform } from 'react-native';
import { diag } from './diag';

/**
 * Android runtime permissions.
 *
 * iOS asks at the point of use (EventKit and UNUserNotificationCenter both
 * prompt themselves from the native module), but Android grants nothing until
 * the app asks: without this the calendar tools reject with "no_permission"
 * forever and notifications never appear, with no prompt to explain why.
 *
 * Asked once when the app is ready rather than at first tool use — a
 * permission sheet appearing mid-agent-run reads as a malfunction.
 */
export async function ensureAndroidPermissions(): Promise<void> {
  if (Platform.OS !== 'android') return;
  const wanted: string[] = [
    PermissionsAndroid.PERMISSIONS.READ_CALENDAR,
    PermissionsAndroid.PERMISSIONS.WRITE_CALENDAR,
  ];
  // POST_NOTIFICATIONS only exists on API 33+; requesting it on older
  // versions throws rather than no-ops.
  if (typeof Platform.Version === 'number' && Platform.Version >= 33) {
    wanted.push(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
  }
  try {
    const result = await PermissionsAndroid.requestMultiple(wanted);
    const denied = Object.entries(result)
      .filter(([, state]) => state !== PermissionsAndroid.RESULTS.GRANTED)
      .map(([name]) => name.replace('android.permission.', ''));
    diag(
      denied.length === 0
        ? 'permissions: all granted'
        : `permissions: denied ${denied.join(', ')}`,
    );
  } catch (err) {
    diag(`permissions: request failed ${err instanceof Error ? err.message : String(err)}`);
  }
}
