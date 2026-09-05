import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useModelStore } from '../stores/modelStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useSessionStore } from '../stores/sessionStore';
import { allModels } from '../services/models';
import { space, usePalette } from '../theme';
import { Button, Field, Header, Label, Row, Screen, Toggle } from '../ui/primitives';

/**
 * Settings — the controls that change behaviour: which brain answers, whether
 * side-effecting tools ask first, voice, and data. Every control is live.
 */
export default function SettingsScreen({ onClose, onOpenBrain }: { onClose: () => void; onOpenBrain: () => void }): React.JSX.Element {
  const p = usePalette();
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
  const [modelName, setModelName] = useState(activeModelId);
  React.useEffect(() => {
    void allModels().then((ms) => setModelName(ms.find((m) => m.id === activeModelId)?.name ?? activeModelId));
  }, [activeModelId]);

  return (
    <Screen>
      <Header title="Settings" onClose={onClose} />
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <Group label="brain">
          <Row title="On-device model" subtitle={modelName} onPress={onOpenBrain} first last={!remote.enabled} />
          <Row
            title="Use a remote endpoint"
            subtitle="Any OpenAI-compatible server instead of the phone. The header shows which one answered."
            right={<Toggle value={remote.enabled} onChange={(on) => setRemote({ enabled: on })} />}
            first={false}
            last={!remote.enabled}
          />
          {remote.enabled ? (
            <View style={[styles.fields, { backgroundColor: p.surface, borderColor: p.line }]}>
              <Field label="Base URL" value={remote.baseUrl} placeholder="http://192.168.1.20:8080/v1" onChangeText={(v) => setRemote({ baseUrl: v })} keyboardType="url" />
              <Field label="API key (optional)" value={remote.apiKey} placeholder="sk-…" secureTextEntry onChangeText={(v) => setRemote({ apiKey: v })} />
              <Field label="Model" value={remote.model} placeholder="qwen3.6-35b-a3b" onChangeText={(v) => setRemote({ model: v })} />
            </View>
          ) : null}
        </Group>

        <Group label="safety">
          <Row
            title="Ask before acting for me"
            subtitle="Email, texts, calls and every tool you added show a card first."
            right={<Toggle value={requireApprovals} onChange={setRequireApprovals} />}
            first
            last
          />
        </Group>

        <Group label="voice">
          <Row
            title="Hands-free"
            subtitle='After each answer the mic re-arms and waits for "Minimus …". Off: tap the mic each time.'
            right={<Toggle value={voiceHandsFree} onChange={setVoiceHandsFree} />}
            first
            last
          />
        </Group>

        <Group label="data">
          <Row
            title={confirmWipe ? 'Tap again to delete every chat' : 'Delete all chats'}
            subtitle={`${sessions.length} saved conversation${sessions.length === 1 ? '' : 's'} on this phone. Memory and taught phrases are kept.`}
            onPress={() => {
              if (!confirmWipe) {
                setConfirmWipe(true);
                setTimeout(() => setConfirmWipe(false), 4000);
                return;
              }
              for (const s of sessions) deleteSession(s.id);
              setConfirmWipe(false);
            }}
            right={<Text style={{ color: confirmWipe ? p.danger : p.ink3, fontSize: 12 }}>{confirmWipe ? 'sure?' : ''}</Text>}
            first
            last
          />
        </Group>

        <Group label="about">
          <View style={[styles.about, { backgroundColor: p.surface, borderColor: p.line }]}>
            <Text style={[styles.aboutTitle, { color: p.ink }]}>Minimus</Text>
            <Text style={[styles.aboutText, { color: p.ink2 }]}>
              A small agent that runs entirely on this phone. Conversations, memory and taught phrases never leave it unless you switch on a remote endpoint. Apache 2.0.
            </Text>
            <Button label="Close" kind="ghost" small onPress={onClose} style={{ alignSelf: 'flex-start', marginTop: space(2) }} />
          </View>
        </Group>
      </ScrollView>
    </Screen>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <View style={styles.group}>
      <Label style={{ marginLeft: space(1) }}>{label}</Label>
      <View>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: space(4), paddingBottom: space(12), gap: space(6) },
  group: { gap: space(2) },
  fields: { gap: space(3), padding: space(4), borderWidth: 1, borderTopWidth: 0, borderBottomLeftRadius: 20, borderBottomRightRadius: 20 },
  about: { borderWidth: 1, borderRadius: 20, padding: space(4), gap: space(1.5) },
  aboutTitle: { fontSize: 16, fontWeight: '700' },
  aboutText: { fontSize: 13, lineHeight: 19 },
});
