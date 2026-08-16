import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { RunAnywhere } from '@runanywhere/core';
import { InferenceFramework } from '@runanywhere/proto-ts/model_types';
import { AGENT_MODELS } from '../services/catalog';
import { useModelStore } from '../stores/modelStore';
import {
  downloadUrl,
  idFor,
  listGgufFiles,
  searchGgufModels,
  type HubGgufFile,
  type HubModel,
} from '../services/huggingface';
import { color, font, radius, space } from '../theme';

/**
 * Model manager: curated agent catalog with download/select/delete, plus
 * "add from Hugging Face" (search → pick GGUF → register+download).
 */

interface Row {
  id: string;
  name: string;
  sizeLabel: string;
  downloaded: boolean;
  progress?: number; // 0-100 while downloading
}

function gb(bytes: number): string {
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

export default function ModelsScreen({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { activeModelId, setActiveModel } = useModelStore();
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [hubQuery, setHubQuery] = useState('');
  const [hubResults, setHubResults] = useState<HubModel[]>([]);
  const [hubFiles, setHubFiles] = useState<{ repo: string; files: HubGgufFile[] } | null>(null);
  const [hubBusy, setHubBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const all = await RunAnywhere.models.list();
      const downloaded = new Set(
        (await RunAnywhere.models.list({ downloadedOnly: true })).map((m) => m.id),
      );
      const known = new Map(AGENT_MODELS.map((m) => [m.id, m]));
      const list: Row[] = all
        .filter((m) => known.has(m.id) || m.id.startsWith('hf-'))
        .map((m) => ({
          id: m.id,
          name: known.get(m.id)?.name ?? m.name ?? m.id,
          sizeLabel: gb(known.get(m.id)?.memoryRequirementBytes ?? Number(m.downloadSizeBytes ?? 0)),
          downloaded: downloaded.has(m.id),
        }));
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

  const download = useCallback(
    async (id: string) => {
      try {
        for await (const ev of RunAnywhere.models.download(id)) {
          if (ev.type === 'progress') {
            setRows((prev) =>
              prev.map((r) => (r.id === id ? { ...r, progress: Math.round(ev.percent) } : r)),
            );
          }
          if (ev.type === 'failed') throw ev.error ?? new Error('download failed');
        }
        setRows((prev) =>
          prev.map((r) => (r.id === id ? { ...r, downloaded: true, progress: undefined } : r)),
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setRows((prev) => prev.map((r) => (r.id === id ? { ...r, progress: undefined } : r)));
      }
    },
    [],
  );

  const remove = useCallback(
    async (id: string) => {
      try {
        await RunAnywhere.models.delete(id);
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [refresh],
  );

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
        const id = idFor(repo, file.filename);
        await RunAnywhere.models.register({
          id,
          name: `${repo.split('/')[1] ?? repo} · ${file.quant}`,
          url: downloadUrl(repo, file.filename),
          framework: InferenceFramework.INFERENCE_FRAMEWORK_LLAMA_CPP,
          memoryRequirementBytes: Math.round(file.sizeBytes * 1.15),
        });
        setHubFiles(null);
        setHubResults([]);
        setHubQuery('');
        await refresh();
        void download(id);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [download, refresh],
  );

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.title}>Models</Text>
        <TouchableOpacity onPress={onClose} hitSlop={12}>
          <Text style={styles.close}>Done</Text>
        </TouchableOpacity>
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      {busy ? (
        <ActivityIndicator color={color.amber} style={{ marginTop: space(8) }} />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.id}
          contentContainerStyle={styles.list}
          ListHeaderComponent={<Text style={styles.section}>agent models</Text>}
          renderItem={({ item }) => (
            <View style={styles.row}>
              <View style={styles.rowText}>
                <Text style={styles.name} numberOfLines={1}>
                  {item.name}
                </Text>
                <Text style={styles.meta}>
                  {item.sizeLabel}
                  {item.id === activeModelId ? '  ·  active' : ''}
                </Text>
              </View>
              {item.progress !== undefined ? (
                <View style={styles.progressWrap}>
                  <Text style={styles.progress}>{item.progress}%</Text>
                  <View style={styles.progressTrack}>
                    <View style={[styles.progressFill, { width: `${item.progress}%` }]} />
                  </View>
                </View>
              ) : item.downloaded ? (
                item.id === activeModelId ? (
                  <View style={[styles.btn, styles.btnActive]}>
                    <Text style={styles.btnActiveText}>in use</Text>
                  </View>
                ) : (
                  <View style={styles.btnRow}>
                    <TouchableOpacity
                      style={styles.btn}
                      onPress={() => setActiveModel(item.id)}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      accessibilityRole="button"
                      accessibilityLabel="Use model"
                    >
                      <Text style={styles.btnText}>use</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.btn}
                      onPress={() =>
                        Alert.alert('Delete this model?', item.name, [
                          { text: 'Cancel', style: 'cancel' },
                          { text: 'Delete', style: 'destructive', onPress: () => void remove(item.id) },
                        ])
                      }
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      accessibilityRole="button"
                      accessibilityLabel="Delete model"
                    >
                      <Text style={styles.btnDangerText}>delete</Text>
                    </TouchableOpacity>
                  </View>
                )
              ) : (
                <TouchableOpacity
                  style={[styles.btn, styles.btnAmber]}
                  onPress={() => void download(item.id)}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  accessibilityRole="button"
                  accessibilityLabel="Download model"
                >
                  <Text style={styles.btnAmberText}>get</Text>
                </TouchableOpacity>
              )}
            </View>
          )}
          ListFooterComponent={
            <View style={styles.hub}>
              <Text style={styles.section}>add from hugging face</Text>
              <View style={styles.hubSearchRow}>
                <TextInput
                  style={styles.hubInput}
                  value={hubQuery}
                  onChangeText={setHubQuery}
                  placeholder="Search GGUF models…"
                  placeholderTextColor={color.faint}
                  onSubmitEditing={() => void hubSearch()}
                  autoCapitalize="none"
                />
                <TouchableOpacity style={[styles.btn, styles.btnAmber]} onPress={() => void hubSearch()}>
                  <Text style={styles.btnAmberText}>search</Text>
                </TouchableOpacity>
              </View>
              {hubBusy ? <ActivityIndicator color={color.amber} /> : null}
              {hubFiles
                ? hubFiles.files.map((f) => (
                    <TouchableOpacity
                      key={f.filename}
                      style={styles.row}
                      onPress={() => void hubAdd(hubFiles.repo, f)}
                    >
                      <View style={styles.rowText}>
                        <Text style={styles.name} numberOfLines={1}>
                          {f.quant}
                        </Text>
                        <Text style={styles.meta} numberOfLines={1}>
                          {f.filename} · {gb(f.sizeBytes)}
                        </Text>
                      </View>
                      <Text style={styles.btnAmberText}>add</Text>
                    </TouchableOpacity>
                  ))
                : hubResults.map((m) => (
                    <TouchableOpacity key={m.id} style={styles.row} onPress={() => void hubPickRepo(m.id)}>
                      <View style={styles.rowText}>
                        <Text style={styles.name} numberOfLines={1}>
                          {m.id}
                        </Text>
                        <Text style={styles.meta}>{m.downloads.toLocaleString()} downloads</Text>
                      </View>
                      <Text style={styles.chev}>›</Text>
                    </TouchableOpacity>
                  ))}
            </View>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg0 },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: space(4),
    paddingVertical: space(3),
  },
  title: { color: color.text, fontSize: 20, fontWeight: '800' },
  close: { color: color.amber, fontSize: 15, fontWeight: '600' },
  error: { color: color.danger, fontSize: 12, paddingHorizontal: space(4) },
  list: { paddingHorizontal: space(4), paddingBottom: space(8) },
  section: {
    color: color.faint,
    fontFamily: font.mono,
    fontSize: 11,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    marginTop: space(4),
    marginBottom: space(2),
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: color.bg1,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: color.line,
    padding: space(3.5),
    marginBottom: space(2),
    gap: space(3),
  },
  rowText: { flex: 1 },
  name: { color: color.text, fontSize: 14, fontWeight: '600' },
  meta: { color: color.dim, fontSize: 12, marginTop: 2 },
  progressWrap: { width: 72, gap: space(1) },
  progress: { color: color.cyan, fontFamily: font.mono, fontSize: 13, textAlign: 'right' },
  progressTrack: {
    width: '100%',
    height: 3,
    borderRadius: 2,
    backgroundColor: color.bg2,
    overflow: 'hidden',
  },
  progressFill: { height: 3, backgroundColor: color.amber },
  btnRow: { flexDirection: 'row', gap: space(2) },
  btn: {
    paddingHorizontal: space(3),
    paddingVertical: space(1.5),
    borderRadius: radius.chip,
    borderWidth: 1,
    borderColor: color.line,
  },
  btnText: { color: color.text, fontSize: 13, fontWeight: '600' },
  btnDangerText: { color: color.danger, fontSize: 13, fontWeight: '600' },
  btnAmber: { backgroundColor: color.amber, borderColor: color.amber },
  btnAmberText: { color: color.bg0, fontSize: 13, fontWeight: '700' },
  btnActive: { borderColor: color.amberDeep },
  btnActiveText: { color: color.amber, fontSize: 13, fontWeight: '600' },
  chev: { color: color.faint, fontSize: 22 },
  hub: { paddingBottom: space(10) },
  hubSearchRow: { flexDirection: 'row', gap: space(2), marginBottom: space(3), alignItems: 'center' },
  hubInput: {
    flex: 1,
    backgroundColor: color.bg1,
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: radius.chip,
    color: color.text,
    paddingHorizontal: space(3),
    height: 42,
  },
});
