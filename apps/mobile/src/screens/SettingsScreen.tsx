import React, { useCallback, useEffect, useState } from 'react';
import {
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useModelStore } from '../stores/modelStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useSessionStore } from '../stores/sessionStore';
import { listMemories, removeMemory, type Memory } from '../tools/memoryTools';
import { loadMacros, removeMacro, type Macro } from '../tools/macroTools';
import { scheduler, type ScheduledTask } from '../services/scheduler';
import { color, font, radius, space } from '../theme';

/**
 * Settings — the control surface for a production agent app: which brain
 * answers (on-device model vs remote endpoint), whether side-effecting tools
 * ask first, and session housekeeping. Every control here is live; nothing
 * is a placebo.
 */

export default function SettingsScreen({
  onClose,
  onOpenModels,
}: {
  onClose: () => void;
  onOpenModels: () => void;
}): React.JSX.Element {
  const activeModelId = useModelStore((s) => s.activeModelId);
  const remote = useSettingsStore((s) => s.remote);
  const setRemote = useSettingsStore((s) => s.setRemote);
  const requireApprovals = useSettingsStore((s) => s.requireApprovals);
  const setRequireApprovals = useSettingsStore((s) => s.setRequireApprovals);
  const voiceHandsFree = useSettingsStore((s) => s.voiceHandsFree);
  const setVoiceHandsFree = useSettingsStore((s) => s.setVoiceHandsFree);
  const sessions = useSessionStore((s) => s.sessions);
  const deleteSession = useSessionStore((s) => s.deleteSession);
  const [confirmWipe, setConfirmWipe] = useState(false);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [macros, setMacros] = useState<Macro[]>([]);
  const [pendingTasks, setPendingTasks] = useState<ScheduledTask[]>([]);

  const refreshAgentData = useCallback(() => {
    void listMemories().then(setMemories).catch(() => setMemories([]));
    void loadMacros().then(setMacros).catch(() => setMacros([]));
    void scheduler.listPending().then(setPendingTasks).catch(() => setPendingTasks([]));
  }, []);
  useEffect(refreshAgentData, [refreshAgentData]);

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.title}>Settings</Text>
        <TouchableOpacity onPress={onClose} hitSlop={12}>
          <Text style={styles.close}>Done</Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.sectionLabel}>brain</Text>
        <TouchableOpacity style={styles.row} onPress={onOpenModels}>
          <View style={styles.rowMain}>
            <Text style={styles.rowTitle}>On-device model</Text>
            <Text style={styles.rowValue}>{activeModelId}</Text>
          </View>
          <Text style={styles.chev}>›</Text>
        </TouchableOpacity>

        <View style={styles.rowSwitch}>
          <View style={styles.rowMain}>
            <Text style={styles.rowTitle}>Use remote endpoint</Text>
            <Text style={styles.rowHint}>
              Route runs to an OpenAI-compatible server instead of the on-device model.
            </Text>
          </View>
          <Switch
            value={remote.enabled}
            onValueChange={(on) => setRemote({ enabled: on })}
            trackColor={{ true: color.amberDeep, false: color.bg2 }}
            thumbColor={remote.enabled ? color.amber : color.faint}
          />
        </View>
        {remote.enabled ? (
          <View style={styles.remoteFields}>
            <Field
              label="Base URL"
              value={remote.baseUrl}
              placeholder="http://192.168.1.20:8080/v1"
              onChange={(v) => setRemote({ baseUrl: v })}
            />
            <Field
              label="API key (optional)"
              value={remote.apiKey}
              placeholder="sk-…"
              secure
              onChange={(v) => setRemote({ apiKey: v })}
            />
            <Field
              label="Model"
              value={remote.model}
              placeholder="qwen3.6-35b-a3b"
              onChange={(v) => setRemote({ model: v })}
            />
          </View>
        ) : null}

        <Text style={styles.sectionLabel}>voice</Text>
        <View style={styles.rowSwitch}>
          <View style={styles.rowMain}>
            <Text style={styles.rowTitle}>Hands-free mode</Text>
            <Text style={styles.rowHint}>
              After each answer the mic re-arms and listens for “Minimus …” — say the wake phrase, then
              your request. Off = tap the mic each time.
            </Text>
          </View>
          <Switch
            value={voiceHandsFree}
            onValueChange={setVoiceHandsFree}
            trackColor={{ true: color.amberDeep, false: color.bg2 }}
            thumbColor={voiceHandsFree ? color.amber : color.faint}
          />
        </View>

        <Text style={styles.sectionLabel}>safety</Text>
        <View style={styles.rowSwitch}>
          <View style={styles.rowMain}>
            <Text style={styles.rowTitle}>Ask before acting for me</Text>
            <Text style={styles.rowHint}>
              Email, texts and calls always show an approval card first.
            </Text>
          </View>
          <Switch
            value={requireApprovals}
            onValueChange={setRequireApprovals}
            trackColor={{ true: color.amberDeep, false: color.bg2 }}
            thumbColor={requireApprovals ? color.amber : color.faint}
          />
        </View>

        <Text style={styles.sectionLabel}>what the agent knows</Text>
        <View style={styles.row}>
          <View style={styles.rowMain}>
            <Text style={styles.rowTitle}>Memories ({memories.length})</Text>
            {memories.length === 0 ? (
              <Text style={styles.rowHint}>Nothing remembered yet.</Text>
            ) : (
              memories.map((m) => (
                <View key={m.id} style={styles.dataRow}>
                  <Text style={styles.dataText} numberOfLines={2}>
                    {m.text}
                  </Text>
                  <TouchableOpacity
                    hitSlop={10}
                    onPress={() => void removeMemory(m.id).then(refreshAgentData)}
                  >
                    <Text style={styles.delete}>✕</Text>
                  </TouchableOpacity>
                </View>
              ))
            )}
          </View>
        </View>
        <View style={styles.row}>
          <View style={styles.rowMain}>
            <Text style={styles.rowTitle}>Taught phrases ({macros.length})</Text>
            {macros.length === 0 ? (
              <Text style={styles.rowHint}>No phrases taught yet.</Text>
            ) : (
              macros.map((m) => (
                <View key={m.name} style={styles.dataRow}>
                  <Text style={styles.dataText} numberOfLines={2}>
                    “{m.name}” · {m.steps.length} step{m.steps.length === 1 ? '' : 's'}
                  </Text>
                  <TouchableOpacity
                    hitSlop={10}
                    onPress={() => void removeMacro(m.name).then(refreshAgentData)}
                  >
                    <Text style={styles.delete}>✕</Text>
                  </TouchableOpacity>
                </View>
              ))
            )}
          </View>
        </View>
        <View style={styles.row}>
          <View style={styles.rowMain}>
            <Text style={styles.rowTitle}>Scheduled tasks ({pendingTasks.length})</Text>
            {pendingTasks.length === 0 ? (
              <Text style={styles.rowHint}>Nothing scheduled.</Text>
            ) : (
              pendingTasks.map((t) => (
                <View key={t.id} style={styles.dataRow}>
                  <Text style={styles.dataText} numberOfLines={2}>
                    {t.instruction}
                  </Text>
                  <TouchableOpacity
                    hitSlop={10}
                    onPress={() => void scheduler.cancel(t.id).then(refreshAgentData)}
                  >
                    <Text style={styles.delete}>✕</Text>
                  </TouchableOpacity>
                </View>
              ))
            )}
          </View>
        </View>

        <Text style={styles.sectionLabel}>data</Text>
        <TouchableOpacity
          style={styles.row}
          onPress={() => {
            if (!confirmWipe) {
              setConfirmWipe(true);
              return;
            }
            for (const s of sessions) deleteSession(s.id);
            setConfirmWipe(false);
          }}
        >
          <View style={styles.rowMain}>
            <Text style={[styles.rowTitle, confirmWipe && styles.danger]}>
              {confirmWipe ? 'Tap again to delete all chats' : 'Delete all chats'}
            </Text>
            <Text style={styles.rowHint}>
              {sessions.length} saved conversation{sessions.length === 1 ? '' : 's'} on this phone.
            </Text>
          </View>
        </TouchableOpacity>

        <Text style={styles.sectionLabel}>about</Text>
        <View style={styles.row}>
          <View style={styles.rowMain}>
            <Text style={styles.rowTitle}>Minimus</Text>
            <Text style={styles.rowHint}>
              Runs entirely on this phone unless a remote endpoint is enabled. Conversations and
              memory never leave the device.
            </Text>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

function Field({
  label,
  value,
  placeholder,
  secure,
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  secure?: boolean;
  onChange: (v: string) => void;
}): React.JSX.Element {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={styles.fieldInput}
        value={value}
        placeholder={placeholder}
        placeholderTextColor={color.faint}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry={secure}
        onChangeText={onChange}
      />
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
  body: { padding: space(4), gap: space(2), paddingBottom: space(10) },
  sectionLabel: {
    color: color.faint,
    fontSize: 11,
    fontFamily: font.mono,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    marginTop: space(3),
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: color.bg1,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: color.line,
    padding: space(3.5),
    gap: space(2),
  },
  rowSwitch: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: color.bg1,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: color.line,
    padding: space(3.5),
    gap: space(2),
  },
  rowMain: { flex: 1, gap: space(1) },
  rowTitle: { color: color.text, fontSize: 14, fontWeight: '600' },
  rowValue: { color: color.cyan, fontSize: 12, fontFamily: font.mono },
  rowHint: { color: color.dim, fontSize: 12, lineHeight: 17 },
  chev: { color: color.faint, fontSize: 22 },
  danger: { color: color.danger },
  dataRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space(2),
    paddingVertical: space(1),
  },
  dataText: { color: color.dim, fontSize: 12, lineHeight: 17, flex: 1 },
  delete: { color: color.faint, fontSize: 14 },
  remoteFields: { gap: space(2) },
  field: {
    backgroundColor: color.bg1,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: color.line,
    padding: space(3),
    gap: space(1.5),
  },
  fieldLabel: { color: color.faint, fontSize: 11, fontFamily: font.mono, letterSpacing: 1 },
  fieldInput: { color: color.text, fontSize: 14, padding: 0 },
});
