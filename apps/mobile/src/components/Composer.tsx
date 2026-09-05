import React from 'react';
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { VoiceState } from '../services/voice';
import { elevation, font, radius, space, usePalette } from '../theme';
import { IconButton } from '../ui/primitives';
import { GlyphArrowUp, GlyphMic, GlyphPlus, GlyphStop, GlyphX } from '../ui/glyphs';

export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  running,
  voiceState = 'idle',
  voiceDetail,
  onMic,
  attachment,
  onAttach,
  onClearAttachment,
  toolsEnabled = true,
  onToggleTools,
}: {
  value: string;
  onChange: (t: string) => void;
  onSend: () => void;
  onStop: () => void;
  running: boolean;
  voiceState?: VoiceState;
  voiceDetail?: string;
  onMic?: () => void;
  attachment?: string | null;
  onAttach?: () => void;
  onClearAttachment?: () => void;
  /** Per-message switch: off = plain conversation, the model sees no tools. */
  toolsEnabled?: boolean;
  onToggleTools?: () => void;
}): React.JSX.Element {
  const p = usePalette();
  const canSend = value.trim().length > 0 && !running;
  const voiceBusy = voiceState !== 'idle';
  const placeholder = running
    ? 'Working…'
    : voiceState === 'listening'
      ? voiceDetail || 'Listening — tap the mic when you are done'
      : voiceState === 'transcribing'
        ? 'Heard you — writing it down…'
        : voiceState === 'speaking'
          ? 'Speaking — tap the mic to stop'
          : voiceState === 'preparing'
            ? voiceDetail || 'Preparing voice…'
            : toolsEnabled
              ? 'What should I take care of?'
              : 'Just chat — tools are off';
  return (
    <View style={styles.wrap}>
      {attachment ? (
        <View style={[styles.attachChip, { backgroundColor: p.surface, borderColor: p.line }]}>
          <Text style={[styles.attachText, { color: p.ink2 }]} numberOfLines={1}>
            Photo · {attachment}
          </Text>
          <Pressable onPress={onClearAttachment} hitSlop={8} accessibilityRole="button" accessibilityLabel="Remove attachment">
            <GlyphX color={p.ink3} size={12} />
          </Pressable>
        </View>
      ) : null}
      <View
        style={[
          styles.card,
          { backgroundColor: p.surface, borderColor: voiceState === 'listening' ? p.live : p.line },
          elevation(p, 2),
        ]}
      >
        <TextInput
          style={[styles.input, { color: p.ink }]}
          value={value}
          onChangeText={onChange}
          placeholder={placeholder}
          placeholderTextColor={voiceState === 'listening' ? p.live : p.ink3}
          editable={!running && !voiceBusy}
          onSubmitEditing={onSend}
          returnKeyType="default"
          blurOnSubmit={false}
          multiline
        />
        <View style={styles.toolbar}>
          <View style={styles.toolbarLeft}>
            {onAttach ? (
              <IconButton label="Attach a photo" onPress={onAttach} disabled={running} size={36}>
                <GlyphPlus color={p.ink2} size={16} />
              </IconButton>
            ) : null}
            {onMic ? (
              <IconButton
                label={voiceBusy ? 'Stop voice input' : 'Speak'}
                onPress={onMic}
                disabled={running && !voiceBusy}
                size={36}
                tone={voiceState === 'listening' ? 'live' : voiceState === 'speaking' ? 'accent' : 'surface'}
              >
                <GlyphMic color={voiceBusy ? p.onAccent : p.ink2} size={16} />
              </IconButton>
            ) : null}
            {onToggleTools ? (
              <Pressable
                onPress={onToggleTools}
                disabled={running}
                hitSlop={6}
                accessibilityRole="switch"
                accessibilityState={{ checked: toolsEnabled }}
                accessibilityLabel={toolsEnabled ? 'Tools on. Tap to chat without tools' : 'Tools off. Tap to allow tools'}
                style={[styles.toolsPill, { backgroundColor: toolsEnabled ? p.surface2 : p.accentSoft, borderColor: toolsEnabled ? p.line : p.accent }]}
              >
                <View style={[styles.toolsDot, { backgroundColor: toolsEnabled ? p.ok : p.accent }]} />
                <Text style={[styles.toolsText, { color: toolsEnabled ? p.ink2 : p.accent }]}>{toolsEnabled ? 'tools' : 'chat only'}</Text>
              </Pressable>
            ) : null}
          </View>
          {running ? (
            <IconButton label="Stop" onPress={onStop} tone="danger" size={36}>
              <GlyphStop color={p.onAccent} size={12} />
            </IconButton>
          ) : (
            <IconButton label="Send" onPress={onSend} disabled={!canSend} tone={canSend ? 'ink' : 'surface'} size={36}>
              <GlyphArrowUp color={canSend ? p.bg : p.ink3} size={16} />
            </IconButton>
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: space(3), paddingTop: space(1), paddingBottom: Platform.OS === 'ios' ? space(1) : space(3) },
  card: { borderRadius: radius.xl, borderWidth: 1, paddingHorizontal: space(3), paddingTop: space(2), paddingBottom: space(2), gap: space(1) },
  input: { fontSize: 17, lineHeight: 23, maxHeight: 140, paddingHorizontal: space(1.5), paddingVertical: space(2), letterSpacing: -0.2 },
  toolbar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  toolbarLeft: { flexDirection: 'row', alignItems: 'center', gap: space(2) },
  hint: { fontFamily: font.mono, fontSize: 10, letterSpacing: 1, textTransform: 'uppercase', marginLeft: space(1) },
  toolsPill: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: space(2.5), height: 30, marginLeft: space(1) },
  toolsDot: { width: 6, height: 6, borderRadius: 3 },
  toolsText: { fontFamily: font.mono, fontSize: 10, letterSpacing: 1, textTransform: 'uppercase' },
  attachChip: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: space(2),
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: space(3),
    paddingVertical: space(1.5),
    marginBottom: space(2),
    marginLeft: space(2),
    maxWidth: '80%',
  },
  attachText: { fontSize: 12, flexShrink: 1 },
});
