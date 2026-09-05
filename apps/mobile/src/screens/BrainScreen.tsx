import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import DeviceInfo from 'react-native-device-info';
import {
  addCustomModel,
  allModels,
  cancelDownload,
  deleteModel,
  downloadModel,
  formatBytes,
  isDownloaded,
  removeCustomModel,
  type ModelSpec,
} from '../services/models';
import { engine } from '../services/engine';
import { useModelStore } from '../stores/modelStore';
import { downloadUrl, idFor, listGgufFiles, searchGgufModels, type HubGgufFile, type HubModel } from '../services/huggingface';
import { elevation, font, radius, space, usePalette } from '../theme';
import { Button, Chip, Field, Header, Label, Screen, Segmented, Toggle } from '../ui/primitives';

/**
 * Brain — which model answers and how the engine runs it. Every model card
 * says what it trades (speed against judgment) in one line, and the engine
 * card shows the numbers this phone actually produces.
 */

interface Row {
  spec: ModelSpec;
  downloaded: boolean;
  progress?: number;
  rate?: string;
}

const TIER_LABEL = { fast: 'Fast', balanced: 'Balanced', deep: 'Deep' } as const;

export default function BrainScreen({ onClose }: { onClose: () => void }): React.JSX.Element {
  const p = usePalette();
  const activeModelId = useModelStore((s) => s.activeModelId);
  const setActiveModel = useModelStore((s) => s.setActiveModel);
  const prefs = useModelStore((s) => s.prefs);
  const setPrefs = useModelStore((s) => s.setPrefs);
  const engineState = useModelStore((s) => s.engineState);
  const lastBench = useModelStore((s) => s.lastBench);
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [ram, setRam] = useState(0);
  const [benching, setBenching] = useState(false);
  const [hubOpen, setHubOpen] = useState(false);
  const [hubQuery, setHubQuery] = useState('');
  const [hubResults, setHubResults] = useState<HubModel[]>([]);
  const [hubFiles, setHubFiles] = useState<{ repo: string; files: HubGgufFile[] } | null>(null);
  const [hubBusy, setHubBusy] = useState(false);
  const aborts = useRef(new Map<string, AbortController>());

  const refresh = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const specs = await allModels();
      const total = await DeviceInfo.getTotalMemory();
      setRam(total);
      const list: Row[] = [];
      for (const spec of specs) {
        if (spec.minRamBytes && total < spec.minRamBytes) continue;
        list.push({ spec, downloaded: await isDownloaded(spec) });
      }
      setRows(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const download = useCallback(async (spec: ModelSpec) => {
    const abort = new AbortController();
    aborts.current.set(spec.id, abort);
    setRows((prev) => prev.map((r) => (r.spec.id === spec.id ? { ...r, progress: 0 } : r)));
    try {
      await downloadModel(
        spec,
        (pr) =>
          setRows((prev) =>
            prev.map((r) =>
              r.spec.id === spec.id ? { ...r, progress: Math.round(pr.fraction * 100), rate: pr.bytesPerSecond ? `${formatBytes(pr.bytesPerSecond)}/s` : '' } : r,
            ),
          ),
        abort.signal,
      );
      setRows((prev) => prev.map((r) => (r.spec.id === spec.id ? { ...r, downloaded: true, progress: undefined } : r)));
    } catch (e) {
      if (!abort.signal.aborted) setError(e instanceof Error ? e.message : String(e));
      setRows((prev) => prev.map((r) => (r.spec.id === spec.id ? { ...r, progress: undefined } : r)));
    } finally {
      aborts.current.delete(spec.id);
    }
  }, []);

  const remove = useCallback(
    async (spec: ModelSpec) => {
      try {
        if (engine.getInfo()?.modelId === spec.id) await engine.unload();
        await deleteModel(spec);
        if (spec.custom) await removeCustomModel(spec.id);
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [refresh],
  );

  const use = useCallback(
    async (spec: ModelSpec) => {
      setActiveModel(spec.id);
      try {
        await useModelStore.getState().ensureLoaded();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [setActiveModel],
  );

  const bench = useCallback(async () => {
    setBenching(true);
    setError('');
    try {
      await useModelStore.getState().ensureLoaded();
      const r = await engine.bench();
      useModelStore.getState().setLastBench({ modelId: activeModelId, prefillTps: r.prefillTps, decodeTps: r.decodeTps, atMs: Date.now() });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBenching(false);
    }
  }, [activeModelId]);

  const hubSearch = useCallback(async () => {
    if (!hubQuery.trim()) return;
    setHubBusy(true);
    setHubFiles(null);
    try {
      setHubResults(await searchGgufModels(hubQuery.trim()));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setHubBusy(false);
    }
  }, [hubQuery]);

  const hubPickRepo = useCallback(async (repo: string) => {
    setHubBusy(true);
    try {
      setHubFiles({ repo, files: await listGgufFiles(repo) });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setHubBusy(false);
    }
  }, []);

  const hubAdd = useCallback(
    async (repo: string, file: HubGgufFile) => {
      try {
        const spec = await addCustomModel({
          id: idFor(repo, file.filename),
          name: `${repo.split('/')[1] ?? repo} · ${file.quant}`,
          tagline: `From Hugging Face: ${repo}`,
          url: downloadUrl(repo, file.filename),
          file: file.filename.split('/').pop()!,
          sizeBytes: file.sizeBytes,
        });
        setHubFiles(null);
        setHubResults([]);
        setHubQuery('');
        setHubOpen(false);
        await refresh();
        void download(spec);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [download, refresh],
  );

  const info = engineState.status === 'ready' ? engineState.info : null;

  return (
    <Screen>
      <Header title="Brain" eyebrow={ram ? `${(ram / 1e9).toFixed(0)} GB phone` : undefined} onClose={onClose} />
      {error ? <Text style={[styles.error, { color: p.danger }]}>{error}</Text> : null}
      {busy ? (
        <ActivityIndicator color={p.ink} style={{ marginTop: space(8) }} />
      ) : (
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <View style={styles.cards}>
            {rows.map(({ spec, downloaded, progress, rate }) => {
              const active = spec.id === activeModelId;
              return (
                <View key={spec.id} style={[styles.card, { backgroundColor: p.surface, borderColor: active ? p.ink : p.line }, elevation(p, 1)]}>
                  <View style={styles.cardHead}>
                    <Label tone={spec.tier === 'fast' ? 'live' : spec.tier === 'deep' ? 'accent' : 'muted'}>{TIER_LABEL[spec.tier]}</Label>
                    <Label>{spec.params} · {formatBytes(spec.sizeBytes)}</Label>
                  </View>
                  <Text style={[styles.name, { color: p.ink }]}>{spec.name}</Text>
                  <Text style={[styles.tagline, { color: p.ink2 }]}>{spec.tagline}</Text>
                  <View style={styles.cardFoot}>
                    {progress !== undefined ? (
                      <View style={{ flex: 1, gap: space(1.5) }}>
                        <View style={[styles.track, { backgroundColor: p.surface2 }]}>
                          <View style={[styles.fill, { width: `${progress}%`, backgroundColor: p.ink }]} />
                        </View>
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                          <Text style={[styles.meta, { color: p.ink2 }]}>
                            {progress}% {rate ? `· ${rate}` : ''}
                          </Text>
                          <Pressable onPress={() => cancelDownload(spec.id)}>
                            <Text style={[styles.meta, { color: p.danger }]}>cancel</Text>
                          </Pressable>
                        </View>
                      </View>
                    ) : downloaded ? (
                      active ? (
                        <>
                          <Chip label="In use" active />
                          <Text style={[styles.meta, { color: p.ink3, flex: 1 }]}>{spec.thinking ? 'thinks when the ask needs judgment' : 'no thinking pass'}</Text>
                        </>
                      ) : (
                        <>
                          <Button label="Use this brain" small onPress={() => void use(spec)} />
                          <Pressable
                            onPress={() =>
                              Alert.alert('Delete this model?', `${spec.name} (${formatBytes(spec.sizeBytes)}) will be removed from the phone.`, [
                                { text: 'Cancel', style: 'cancel' },
                                { text: 'Delete', style: 'destructive', onPress: () => void remove(spec) },
                              ])
                            }
                            hitSlop={8}
                          >
                            <Text style={[styles.meta, { color: p.ink3 }]}>delete</Text>
                          </Pressable>
                        </>
                      )
                    ) : (
                      <Button label={`Download ${formatBytes(spec.sizeBytes)}`} kind="secondary" small onPress={() => void download(spec)} />
                    )}
                  </View>
                </View>
              );
            })}
          </View>

          <View style={styles.section}>
            <Label style={{ marginLeft: space(1) }}>engine</Label>
            <View style={[styles.engine, { backgroundColor: p.surface, borderColor: p.line }]}>
              <View style={styles.readings}>
                <Reading label="runs on" value={info ? (info.gpu ? 'GPU' : 'CPU') : engineState.status === 'loading' ? `${Math.round(engineState.progress)}%` : '—'} />
                <Reading label="context" value={info ? `${info.contextTokens / 1024}k` : '—'} />
                <Reading label="prefill" value={lastBench && lastBench.modelId === activeModelId ? `${lastBench.prefillTps.toFixed(0)}` : '—'} unit="tok/s" />
                <Reading label="decode" value={lastBench && lastBench.modelId === activeModelId ? `${lastBench.decodeTps.toFixed(0)}` : '—'} unit="tok/s" />
              </View>
              {engineState.status === 'error' ? <Text style={[styles.meta, { color: p.danger }]}>{engineState.message}</Text> : null}
              <View style={styles.knob}>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.knobTitle, { color: p.ink }]}>Run on the GPU</Text>
                  <Text style={[styles.meta, { color: p.ink3 }]}>Metal. Off means CPU only: slower and hotter.</Text>
                </View>
                <Toggle value={prefs.gpu} onChange={(v) => setPrefs({ gpu: v })} />
              </View>
              <View style={styles.knob}>
                <Text style={[styles.knobTitle, { color: p.ink }]}>Context window</Text>
                <View style={{ width: 170 }}>
                  <Segmented options={[{ value: 4096, label: '4k' }, { value: 8192, label: '8k' }, { value: 16384, label: '16k' }]} value={prefs.contextTokens} onChange={(v) => setPrefs({ contextTokens: v })} />
                </View>
              </View>
              <View style={styles.knob}>
                <Text style={[styles.knobTitle, { color: p.ink }]}>CPU threads</Text>
                <View style={{ width: 170 }}>
                  <Segmented options={[{ value: 0, label: 'auto' }, { value: 2, label: '2' }, { value: 4, label: '4' }, { value: 6, label: '6' }]} value={prefs.threads} onChange={(v) => setPrefs({ threads: v })} />
                </View>
              </View>
              <View style={styles.actions}>
                <Button label="Apply and reload" kind="secondary" small onPress={() => void useModelStore.getState().ensureLoaded()} />
                <Button label={benching ? 'Measuring…' : 'Measure speed'} small busy={benching} onPress={() => void bench()} />
              </View>
            </View>
          </View>

          <View style={styles.section}>
            <Pressable onPress={() => setHubOpen((v) => !v)} style={styles.hubHead}>
              <Label style={{ marginLeft: space(1) }}>add from hugging face</Label>
              <Text style={[styles.meta, { color: p.ink3 }]}>{hubOpen ? 'hide' : 'show'}</Text>
            </Pressable>
            {hubOpen ? (
              <View style={{ gap: space(2) }}>
                <View style={styles.hubSearch}>
                  <Field placeholder="Search GGUF models…" value={hubQuery} onChangeText={setHubQuery} onSubmitEditing={() => void hubSearch()} style={{ flex: 1 }} returnKeyType="search" />
                  <Button label="Search" small onPress={() => void hubSearch()} />
                </View>
                {hubBusy ? <ActivityIndicator color={p.ink} /> : null}
                {hubFiles
                  ? hubFiles.files.map((f) => (
                      <Pressable key={f.filename} style={[styles.hubRow, { backgroundColor: p.surface, borderColor: p.line }]} onPress={() => void hubAdd(hubFiles.repo, f)}>
                        <View style={{ flex: 1 }}>
                          <Text style={[styles.name, { color: p.ink, fontSize: 14 }]}>{f.quant}</Text>
                          <Text style={[styles.meta, { color: p.ink3 }]} numberOfLines={1}>
                            {f.filename} · {formatBytes(f.sizeBytes)}
                          </Text>
                        </View>
                        <Text style={[styles.meta, { color: p.ink }]}>add</Text>
                      </Pressable>
                    ))
                  : hubResults.map((m) => (
                      <Pressable key={m.id} style={[styles.hubRow, { backgroundColor: p.surface, borderColor: p.line }]} onPress={() => void hubPickRepo(m.id)}>
                        <View style={{ flex: 1 }}>
                          <Text style={[styles.name, { color: p.ink, fontSize: 14 }]} numberOfLines={1}>
                            {m.id}
                          </Text>
                          <Text style={[styles.meta, { color: p.ink3 }]}>{m.downloads.toLocaleString()} downloads</Text>
                        </View>
                      </Pressable>
                    ))}
              </View>
            ) : null}
          </View>
        </ScrollView>
      )}
    </Screen>
  );
}

function Reading({ label, value, unit }: { label: string; value: string; unit?: string }): React.JSX.Element {
  const p = usePalette();
  return (
    <View style={{ flex: 1, gap: 2 }}>
      <Label>{label}</Label>
      <Text style={[styles.readingValue, { color: p.ink }]}>
        {value}
        {unit && value !== '—' ? <Text style={[styles.readingUnit, { color: p.ink3 }]}> {unit}</Text> : null}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  error: { fontSize: 12, paddingHorizontal: space(5), fontFamily: font.mono },
  body: { paddingHorizontal: space(4), paddingBottom: space(12), gap: space(7) },
  cards: { gap: space(3) },
  card: { borderWidth: 1, borderRadius: radius.lg, padding: space(4), gap: space(1.5) },
  cardHead: { flexDirection: 'row', justifyContent: 'space-between' },
  name: { fontSize: 18, fontWeight: '700', letterSpacing: -0.4 },
  tagline: { fontSize: 13, lineHeight: 18 },
  cardFoot: { flexDirection: 'row', alignItems: 'center', gap: space(3), marginTop: space(2) },
  meta: { fontSize: 11, fontFamily: font.mono },
  track: { height: 4, borderRadius: 2, overflow: 'hidden' },
  fill: { height: 4 },
  section: { gap: space(2) },
  engine: { borderWidth: 1, borderRadius: radius.lg, padding: space(4), gap: space(4) },
  readings: { flexDirection: 'row', gap: space(2) },
  readingValue: { fontSize: 22, fontWeight: '700', letterSpacing: -0.6, fontVariant: ['tabular-nums'] },
  readingUnit: { fontSize: 11, fontFamily: font.mono, fontWeight: '400' },
  knob: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space(3) },
  knobTitle: { fontSize: 15, fontWeight: '600' },
  actions: { flexDirection: 'row', gap: space(2), justifyContent: 'flex-end' },
  hubHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingRight: space(1) },
  hubSearch: { flexDirection: 'row', gap: space(2), alignItems: 'flex-end' },
  hubRow: { flexDirection: 'row', alignItems: 'center', gap: space(3), borderWidth: 1, borderRadius: radius.md, padding: space(3.5) },
});
