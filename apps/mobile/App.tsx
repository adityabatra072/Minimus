import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Easing, StatusBar, StyleSheet, Text, View, useColorScheme, useWindowDimensions } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import OnboardingScreen from './src/screens/OnboardingScreen';
import ChatScreen, { type Destination } from './src/screens/ChatScreen';
import ClockScreen from './src/screens/ClockScreen';
import { useClockStore } from './src/services/clock';
import BrainScreen from './src/screens/BrainScreen';
import DiagnosticsScreen from './src/screens/DiagnosticsScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import HistoryScreen from './src/screens/HistoryScreen';
import ToolsScreen from './src/screens/ToolsScreen';
import MemoryScreen from './src/screens/MemoryScreen';
import { useModelStore } from './src/stores/modelStore';
import { useSettingsStore } from './src/stores/settingsStore';
import { useSessionStore } from './src/stores/sessionStore';
import { useToolStore } from './src/stores/toolStore';
import { scheduler } from './src/services/scheduler';
import { runAgentHeadless } from './src/services/headlessAgent';
import { ensureAndroidPermissions, ensureIosNotificationPermission } from './src/services/permissions';
import { syncToolPlatform } from './src/services/toolPlatform';
import { getToolRegistry } from './src/tools';
import { adoptLegacyModels } from './src/services/models';
import { registerQaHandler, startQaBridge } from './src/services/qaBridge';
import { runSelfTests } from './src/services/selfTest';
import { runDeepChecks } from './src/services/deepTest';
import { engine } from './src/services/engine';
import { deviceHealth } from './src/services/health';
import { dark, light, space } from './src/theme';
import { Button } from './src/ui/primitives';
import { Core } from './src/ui/Core';

type AppState = 'initializing' | 'setup' | 'ready' | 'error';

export default function App(): React.JSX.Element {
  const scheme = useColorScheme();
  const p = scheme === 'dark' ? dark : light;
  const [state, setState] = useState<AppState>('initializing');
  const [error, setError] = useState('');
  const [screen, setScreen] = useState<Destination | null>(null);

  const boot = useCallback(async () => {
    setState('initializing');
    try {
      await Promise.all([
        useModelStore.getState().hydrate(),
        useSettingsStore.getState().hydrate(),
        useSessionStore.getState().hydrate(),
        useToolStore.getState().hydrate(),
        useClockStore.getState().hydrate(),
      ]);
      await adoptLegacyModels().catch(() => []);
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

  // Laptop-driven QA (services/qaBridge): off unless a QA host is configured.
  useEffect(() => {
    void startQaBridge();
    const offs = [
      registerQaHandler('navigate', async (args) => {
        const target = String(args['screen'] ?? 'chat');
        const map: Record<string, Destination | null> = {
          chat: null,
          home: null,
          history: 'history',
          chats: 'history',
          brain: 'brain',
          models: 'brain',
          tools: 'tools',
          memory: 'memory',
          settings: 'settings',
          diagnostics: 'diagnostics',
          rehearsal: 'diagnostics',
          clock: 'clock',
          alarms: 'clock',
          timers: 'clock',
        };
        if (!(target in map)) throw new Error(`unknown screen ${target}`);
        setScreen(map[target] ?? null);
        return { screen: map[target] ?? 'chat' };
      }),
      registerQaHandler('checks', async () => runSelfTests()),
      registerQaHandler('deep', async () => runDeepChecks()),
      registerQaHandler('bench', async () => {
        await useModelStore.getState().ensureLoaded();
        return { ...(await engine.bench()), info: engine.getInfo() };
      }),
      registerQaHandler('loadModel', async (args) => {
        if (typeof args['id'] === 'string') useModelStore.getState().setActiveModel(args['id']);
        if (args['prefs'] && typeof args['prefs'] === 'object') {
          useModelStore.getState().setPrefs(args['prefs'] as Record<string, never>);
        }
        await useModelStore.getState().ensureLoaded();
        return engine.getInfo();
      }),
      registerQaHandler('state', async () => ({
        app: state,
        screen: screen ?? 'chat',
        model: useModelStore.getState().activeModelId,
        prefs: useModelStore.getState().prefs,
        engine: engine.getState(),
        health: await deviceHealth(),
        settings: useSettingsStore.getState(),
        tools: useToolStore.getState(),
        sessions: useSessionStore.getState().sessions.length,
      })),
    ];
    return () => offs.forEach((off) => off());
  }, [state, screen]);

  // The scheduler lives above the screens: a deferred task has to fire whether
  // the user is on the chat, the model manager or the diagnostics screen. The
  // chat screen swaps in a richer runner while it's mounted.
  useEffect(() => {
    if (state !== 'ready') return;
    void ensureAndroidPermissions();
    void ensureIosNotificationPermission();
    scheduler.setRunner(runAgentHeadless);
    scheduler.start();
    void scheduler.tick();
  }, [state]);

  const close = useCallback(() => setScreen(null), []);

  return (
    <SafeAreaProvider>
      <StatusBar barStyle={scheme === 'dark' ? 'light-content' : 'dark-content'} backgroundColor={p.bg} />
      <View style={[styles.root, { backgroundColor: p.bg }]}>
        {state === 'initializing' && (
          <View style={styles.center}>
            <Core state="thinking" size={40} />
          </View>
        )}
        {state === 'setup' && <OnboardingScreen onReady={() => setState('ready')} />}
        {state === 'ready' && (
          <>
            <ChatScreen onOpen={setScreen} />
            <Sheet visible={screen !== null}>
              {screen === 'brain' ? (
                <BrainScreen onClose={close} />
              ) : screen === 'diagnostics' ? (
                <DiagnosticsScreen onClose={close} />
              ) : screen === 'settings' ? (
                <SettingsScreen onClose={close} onOpenBrain={() => setScreen('brain')} />
              ) : screen === 'tools' ? (
                <ToolsScreen onClose={close} />
              ) : screen === 'clock' ? (
                <ClockScreen onClose={close} />
              ) : screen === 'memory' ? (
                <MemoryScreen onClose={close} />
              ) : screen === 'history' ? (
                <HistoryScreen
                  onClose={close}
                  onPick={(id) => {
                    useSessionStore.getState().openSession(id);
                    close();
                  }}
                />
              ) : null}
            </Sheet>
          </>
        )}
        {state === 'error' && (
          <View style={styles.center}>
            <Text style={[styles.error, { color: p.danger }]}>Could not start: {error}</Text>
            <Button label="Retry" onPress={() => void boot()} />
          </View>
        )}
      </View>
    </SafeAreaProvider>
  );
}

/**
 * Secondary screens slide up over the chat like a sheet and slide back down.
 * The chat stays mounted underneath, so a run in progress keeps going.
 */
function Sheet({ visible, children }: { visible: boolean; children: React.ReactNode }): React.JSX.Element | null {
  const { height } = useWindowDimensions();
  const y = useRef(new Animated.Value(height)).current;
  const [mounted, setMounted] = useState(visible);
  useEffect(() => {
    if (visible) {
      setMounted(true);
      Animated.timing(y, { toValue: 0, duration: 320, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    } else {
      Animated.timing(y, { toValue: height, duration: 260, easing: Easing.in(Easing.cubic), useNativeDriver: true }).start(({ finished }) => {
        if (finished) setMounted(false);
      });
    }
  }, [visible, y, height]);
  if (!mounted) return null;
  return <Animated.View style={[StyleSheet.absoluteFill, { transform: [{ translateY: y }] }]}>{children}</Animated.View>;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space(4), padding: space(6) },
  error: { textAlign: 'center', fontSize: 14, lineHeight: 20 },
});
