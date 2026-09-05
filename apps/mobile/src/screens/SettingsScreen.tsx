import React, { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useModelStore } from '../stores/modelStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useSessionStore } from '../stores/sessionStore';
import { allModels } from '../services/models';
import { listSystemVoices, VoicePipeline } from '../services/voice';
import { setDailyBrief } from '../services/brief';
import { space, usePalette } from '../theme';
import { Button, Field, Header, Label, Row, Screen, Segmented, Toggle } from '../ui/primitives';

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
  const voice = useSettingsStore((s) => s.voice);
  const setVoice = useSettingsStore((s) => s.setVoice);
  const briefTime = useSettingsStore((s) => s.briefTime);
  const [voices, setVoices] = useState<{ id: string; name: string; quality: string }[]>([]);
  const [showVoices, setShowVoices] = useState(false);
  useEffect(() => {
    void listSystemVoices().then(setVoices);
  }, []);
  const currentVoice = voices.find((v) => v.id === voice.systemVoiceId) ?? voices[0];
  const preview = (voiceId: string) => {
    const pipeline = new VoicePipeline({ onState: () => undefined, onUtterance: () => undefined });
    useSettingsStore.getState().setVoice({ systemVoiceId: voiceId });
    void pipeline.speak('Hi, I am Minimus. Flashlight is on, and your meeting is at three.');
  };
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

        <Group label="every day">
          <Row
            title="Morning brief"
            subtitle={
              briefTime
                ? `At ${briefTime} Minimus gathers your calendar, reminders and alarms and tells you about the day. Needs the app open at that time; a notification brings you back.`
                : 'A daily run-down of calendar, reminders and alarms at a time you pick.'
            }
            first
            last
          />
          <View style={[styles.fields, { borderColor: p.line }]}>
            <Segmented
              options={[
                { value: '', label: 'Off' },
                { value: '07:00', label: '7:00' },
                { value: '08:00', label: '8:00' },
                { value: '09:00', label: '9:00' },
              ]}
              value={['', '07:00', '08:00', '09:00'].includes(briefTime) ? briefTime : '08:00'}
              onChange={(t) => void setDailyBrief(t)}
            />
          </View>
        </Group>

        <Group label="voice">
          <Row
            title="Hands-free"
            subtitle='After each answer the mic re-arms and waits for "Minimus …". Off: tap the mic each time.'
            right={<Toggle value={voiceHandsFree} onChange={setVoiceHandsFree} />}
            first
          />
          <Row
            title="Fix what I heard with the model"
            subtitle="A quick pass repairs misheard words toward your taught phrases and app vocabulary."
            right={<Toggle value={voice.llmCorrection} onChange={(on) => setVoice({ llmCorrection: on })} />}
          />
          <Row
            title="Voice"
            subtitle={
              voice.remoteTts.enabled
                ? 'Cloud voice (below)'
                : currentVoice
                  ? `${currentVoice.name} · ${currentVoice.quality}. For the most natural sound, download a Siri or Enhanced voice in iOS Settings › Accessibility › Spoken Content › Voices.`
                  : 'System voice'
            }
            onPress={() => setShowVoices((v) => !v)}
          />
          {showVoices ? (
            <View style={[styles.fields, { borderColor: p.line }]}>
              {voices.slice(0, 12).map((v) => (
                <Row
                  key={v.id}
                  title={v.name}
                  subtitle={`${v.quality}${v.id === (voice.systemVoiceId || voices[0]?.id) ? ' · selected' : ''}`}
                  onPress={() => {
                    setVoice({ systemVoiceId: v.id });
                    setShowVoices(false);
                    preview(v.id);
                  }}
                />
              ))}
            </View>
          ) : null}
          <View style={[styles.fields, { borderColor: p.line }]}>
            <Label style={{ marginBottom: space(1) }}>speaking rate</Label>
            <Segmented
              options={[
                { value: 0.85, label: 'Calm' },
                { value: 1, label: 'Natural' },
                { value: 1.15, label: 'Brisk' },
              ]}
              value={voice.rate}
              onChange={(rate) => setVoice({ rate })}
            />
          </View>
          <Row
            title="Cloud voice"
            subtitle="Speak answers through an OpenAI-compatible speech endpoint instead of the phone's voice."
            right={<Toggle value={voice.remoteTts.enabled} onChange={(on) => setVoice({ remoteTts: { ...voice.remoteTts, enabled: on } })} />}
          />
          {voice.remoteTts.enabled ? (
            <View style={[styles.fields, { borderColor: p.line }]}>
              <Field label="Base URL" value={voice.remoteTts.baseUrl} placeholder="https://api.openai.com/v1" keyboardType="url" onChangeText={(v) => setVoice({ remoteTts: { ...voice.remoteTts, baseUrl: v } })} />
              <Field label="API key" value={voice.remoteTts.apiKey} placeholder="sk-…" secureTextEntry onChangeText={(v) => setVoice({ remoteTts: { ...voice.remoteTts, apiKey: v } })} />
              <Field label="Model" value={voice.remoteTts.model} placeholder="tts-1" onChangeText={(v) => setVoice({ remoteTts: { ...voice.remoteTts, model: v } })} />
              <Field label="Voice" value={voice.remoteTts.voice} placeholder="alloy" onChangeText={(v) => setVoice({ remoteTts: { ...voice.remoteTts, voice: v } })} />
            </View>
          ) : null}
          <Row
            title="Cloud transcription"
            subtitle="Send each recording to an OpenAI-compatible transcription endpoint when on-device hearing is not enough."
            right={<Toggle value={voice.remoteStt.enabled} onChange={(on) => setVoice({ remoteStt: { ...voice.remoteStt, enabled: on } })} />}
            last={!voice.remoteStt.enabled}
          />
          {voice.remoteStt.enabled ? (
            <View style={[styles.fields, { borderColor: p.line }]}>
              <Field label="Base URL" value={voice.remoteStt.baseUrl} placeholder="https://api.openai.com/v1" keyboardType="url" onChangeText={(v) => setVoice({ remoteStt: { ...voice.remoteStt, baseUrl: v } })} />
              <Field label="API key" value={voice.remoteStt.apiKey} placeholder="sk-…" secureTextEntry onChangeText={(v) => setVoice({ remoteStt: { ...voice.remoteStt, apiKey: v } })} />
              <Field label="Model" value={voice.remoteStt.model} placeholder="whisper-1" onChangeText={(v) => setVoice({ remoteStt: { ...voice.remoteStt, model: v } })} />
            </View>
          ) : null}
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
