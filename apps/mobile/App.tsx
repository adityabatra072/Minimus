import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StatusBar, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { initSdk } from './src/services/sdk';
import SetupScreen from './src/screens/SetupScreen';
import ChatScreen from './src/screens/ChatScreen';
import ModelsScreen from './src/screens/ModelsScreen';
import RehearsalScreen from './src/screens/RehearsalScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import HistoryScreen from './src/screens/HistoryScreen';
import ToolsScreen from './src/screens/ToolsScreen';
import { useModelStore } from './src/stores/modelStore';
import { useSettingsStore } from './src/stores/settingsStore';
import { useSessionStore } from './src/stores/sessionStore';
import { useToolStore } from './src/stores/toolStore';
import { scheduler } from './src/services/scheduler';
import { runAgentHeadless } from './src/services/headlessAgent';
import { syncToolPlatform } from './src/services/toolPlatform';
import { getToolRegistry } from './src/tools';
import { color, radius, space } from './src/theme';

type AppState = 'initializing' | 'setup' | 'ready' | 'error';
type Overlay = 'none' | 'models' | 'rehearsal' | 'settings' | 'history' | 'tools';

export default function App(): React.JSX.Element {
  const [state, setState] = useState<AppState>('initializing');
  const [error, setError] = useState('');
  const [overlayScreen, setOverlayScreen] = useState<Overlay>('none');

  const boot = useCallback(async () => {
    setState('initializing');
    try {
      await Promise.all([
        useModelStore.getState().hydrate(),
        useSettingsStore.getState().hydrate(),
        useSessionStore.getState().hydrate(),
        useToolStore.getState().hydrate(),
      ]);
      await initSdk();
      // Custom tools register instantly; MCP servers connect in the
      // background — boot must not block on someone's slow endpoint.
      void syncToolPlatform(getToolRegistry());
      setState('setup');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setState('error');
    }
  }, []);

  useEffect(() => {
    void boot();
  }, [boot]);

  // The scheduler lives above the screens: a deferred task has to fire whether
  // the user is on the chat, the model manager or the rehearsal screen. The
  // chat screen swaps in a richer runner while it's mounted.
  useEffect(() => {
    if (state !== 'ready') return;
    scheduler.setRunner(runAgentHeadless);
    scheduler.start();
    void scheduler.tick();
  }, [state]);

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" backgroundColor={color.bg0} />
      <SafeAreaView style={styles.root} edges={['top', 'bottom']}>
        {state === 'initializing' && (
          <View style={styles.center}>
            <ActivityIndicator color={color.amber} size="large" />
            <Text style={styles.dim}>Starting on-device AI…</Text>
          </View>
        )}
        {state === 'setup' && <SetupScreen onReady={() => setState('ready')} />}
        {state === 'ready' &&
          (overlayScreen === 'models' ? (
            <ModelsScreen onClose={() => setOverlayScreen('none')} />
          ) : overlayScreen === 'rehearsal' ? (
            <RehearsalScreen onClose={() => setOverlayScreen('none')} />
          ) : overlayScreen === 'settings' ? (
            <SettingsScreen
              onClose={() => setOverlayScreen('none')}
              onOpenModels={() => setOverlayScreen('models')}
            />
          ) : overlayScreen === 'tools' ? (
            <ToolsScreen onClose={() => setOverlayScreen('none')} />
          ) : overlayScreen === 'history' ? (
            <HistoryScreen
              onClose={() => setOverlayScreen('none')}
              onPick={(id) => {
                useSessionStore.setState({ activeSessionId: id });
                setOverlayScreen('none');
              }}
            />
          ) : (
            <ChatScreen
              onOpenModels={() => setOverlayScreen('models')}
              onOpenRehearsal={() => setOverlayScreen('rehearsal')}
              onOpenSettings={() => setOverlayScreen('settings')}
              onOpenHistory={() => setOverlayScreen('history')}
              onOpenTools={() => setOverlayScreen('tools')}
            />
          ))}
        {state === 'error' && (
          <View style={styles.center}>
            <Text style={styles.error}>SDK init failed: {error}</Text>
            <TouchableOpacity style={styles.btn} onPress={boot}>
              <Text style={styles.btnText}>Retry</Text>
            </TouchableOpacity>
          </View>
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg0 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space(3), padding: space(6) },
  dim: { color: color.dim },
  error: { color: color.danger, textAlign: 'center' },
  btn: {
    backgroundColor: color.amber,
    borderRadius: radius.chip,
    paddingHorizontal: space(6),
    paddingVertical: space(3),
  },
  btnText: { color: color.bg0, fontWeight: '700' },
});
