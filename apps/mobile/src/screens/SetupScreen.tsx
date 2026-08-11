import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { RunAnywhere } from '@runanywhere/core';
import { DEFAULT_MODEL_ID } from '../services/catalog';

/**
 * First-run gate: makes sure the default agent model is on-device,
 * with live download progress. Full model-manager UI comes later.
 */

type Phase = 'checking' | 'needs_download' | 'downloading' | 'ready' | 'error';

export default function SetupScreen({ onReady }: { onReady: () => void }): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>('checking');
  const [percent, setPercent] = useState(0);
  const [error, setError] = useState('');

  const check = useCallback(async () => {
    setPhase('checking');
    try {
      const downloaded = await RunAnywhere.models.list({ downloadedOnly: true });
      if (downloaded.some((m) => m.id === DEFAULT_MODEL_ID)) {
        // Preload with an agent-sized context — the auto-load default is a
        // 2048 window, which multi-turn tool loops overflow immediately.
        await RunAnywhere.models.load(DEFAULT_MODEL_ID, { contextLength: 8192 });
        setPhase('ready');
        onReady();
      } else {
        setPhase('needs_download');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('error');
    }
  }, [onReady]);

  useEffect(() => {
    void check();
  }, [check]);

  const download = useCallback(async () => {
    setPhase('downloading');
    setPercent(0);
    try {
      for await (const ev of RunAnywhere.models.download(DEFAULT_MODEL_ID)) {
        if (ev.type === 'progress') setPercent(Math.round(ev.percent));
        if (ev.type === 'failed') throw ev.error ?? new Error('download failed');
      }
      await RunAnywhere.models.load(DEFAULT_MODEL_ID, { contextLength: 8192 });
      setPhase('ready');
      onReady();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('error');
    }
  }, [onReady]);

  return (
    <View style={styles.root}>
      <Text style={styles.title}>Minimus</Text>
      {phase === 'checking' && <ActivityIndicator color="#2563eb" size="large" />}
      {phase === 'needs_download' && (
        <>
          <Text style={styles.subtitle}>
            The agent model (LFM2.5 2.6B, ~1.7 GB) needs a one-time download.
          </Text>
          <TouchableOpacity style={styles.btn} onPress={download}>
            <Text style={styles.btnText}>Download model</Text>
          </TouchableOpacity>
        </>
      )}
      {phase === 'downloading' && (
        <>
          <ActivityIndicator color="#2563eb" size="large" />
          <Text style={styles.subtitle}>Downloading… {percent}%</Text>
        </>
      )}
      {phase === 'error' && (
        <>
          <Text style={styles.error}>{error}</Text>
          <TouchableOpacity style={styles.btn} onPress={check}>
            <Text style={styles.btnText}>Retry</Text>
          </TouchableOpacity>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0e0e12', alignItems: 'center', justifyContent: 'center', padding: 24, gap: 16 },
  title: { color: 'white', fontSize: 24, fontWeight: '700' },
  subtitle: { color: '#aaa', fontSize: 14, textAlign: 'center' },
  error: { color: '#f87171', fontSize: 13, textAlign: 'center' },
  btn: { backgroundColor: '#2563eb', borderRadius: 10, paddingHorizontal: 24, paddingVertical: 12 },
  btnText: { color: 'white', fontWeight: '600' },
});
