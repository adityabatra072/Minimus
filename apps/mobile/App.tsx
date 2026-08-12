import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StatusBar, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { initSdk } from './src/services/sdk';
import SetupScreen from './src/screens/SetupScreen';
import ChatScreen from './src/screens/ChatScreen';
import ModelsScreen from './src/screens/ModelsScreen';
import RehearsalScreen from './src/screens/RehearsalScreen';
import { useModelStore } from './src/stores/modelStore';
import { scheduler } from './src/services/scheduler';
import { runAgentHeadless } from './src/services/headlessAgent';

type AppState = 'initializing' | 'setup' | 'ready' | 'error';

export default function App(): React.JSX.Element {
  const [state, setState] = useState<AppState>('initializing');
  const [error, setError] = useState('');
  const [showModels, setShowModels] = useState(false);
  const [showRehearsal, setShowRehearsal] = useState(false);

  const boot = useCallback(async () => {
    setState('initializing');
    try {
      await useModelStore.getState().hydrate();
      await initSdk();
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
      <StatusBar barStyle="light-content" backgroundColor="#0e0e12" />
      <SafeAreaView style={styles.root} edges={['top', 'bottom']}>
        {state === 'initializing' && (
          <View style={styles.center}>
            <ActivityIndicator color="#2563eb" size="large" />
            <Text style={styles.dim}>Starting on-device AI…</Text>
          </View>
        )}
        {state === 'setup' && <SetupScreen onReady={() => setState('ready')} />}
        {state === 'ready' &&
          (showModels ? (
            <ModelsScreen onClose={() => setShowModels(false)} />
          ) : showRehearsal ? (
            <RehearsalScreen onClose={() => setShowRehearsal(false)} />
          ) : (
            <ChatScreen
              onOpenModels={() => setShowModels(true)}
              onOpenRehearsal={() => setShowRehearsal(true)}
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
  root: { flex: 1, backgroundColor: '#0e0e12' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  dim: { color: '#888' },
  error: { color: '#f87171', textAlign: 'center' },
  btn: { backgroundColor: '#2563eb', borderRadius: 10, paddingHorizontal: 24, paddingVertical: 12 },
  btnText: { color: 'white', fontWeight: '600' },
});
