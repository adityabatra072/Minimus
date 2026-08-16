import React from 'react';
import {
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import type { VoiceState } from '../services/voice';
import { color, radius, space } from '../theme';

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
}: {
  value: string;
  onChange: (t: string) => void;
  onSend: () => void;
  onStop: () => void;
  running: boolean;
  /** Current voice pipeline state — drives the mic button + placeholder. */
  voiceState?: VoiceState;
  /** Progress label ("downloading ears 40%") shown while preparing. */
  voiceDetail?: string;
  /** Mic tap: start listening / cancel listening / cut speech short. */
  onMic?: () => void;
  /** Attached image filename, when one is staged for the next message. */
  attachment?: string | null;
  onAttach?: () => void;
  onClearAttachment?: () => void;
}): React.JSX.Element {
  const canSend = value.trim().length > 0 && !running;
  const voiceBusy = voiceState !== 'idle';
  const placeholder = running
    ? 'Working…'
    : voiceState === 'listening'
      ? 'Listening…'
      : voiceState === 'transcribing'
        ? 'Heard you — transcribing…'
        : voiceState === 'speaking'
          ? 'Speaking — tap mic to stop'
          : voiceState === 'preparing'
            ? voiceDetail || 'Preparing voice…'
            : 'Ask me anything';
  return (
    <View style={styles.wrap}>
      {attachment ? (
        <View style={styles.attachChip}>
          <Text style={styles.attachText} numberOfLines={1}>
            🖼 {attachment}
          </Text>
          <TouchableOpacity
            onPress={onClearAttachment}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Remove attachment"
          >
            <Text style={styles.attachClear}>✕</Text>
          </TouchableOpacity>
        </View>
      ) : null}
      <View style={[styles.pill, voiceState === 'listening' && styles.pillListening]}>
        {onAttach ? (
          <TouchableOpacity
            style={styles.mic}
            onPress={onAttach}
            disabled={running}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Attach image"
          >
            <Text style={styles.attachGlyph}>＋</Text>
          </TouchableOpacity>
        ) : null}
        {onMic ? (
          <TouchableOpacity
            style={[styles.mic, voiceBusy && styles.micOn]}
            onPress={onMic}
            disabled={running && !voiceBusy}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={voiceBusy ? 'Stop voice input' : 'Start voice input'}
          >
            <View style={[styles.micGlyph, voiceBusy && styles.micGlyphOn]} />
          </TouchableOpacity>
        ) : null}
        <TextInput
          style={styles.input}
          value={value}
          onChangeText={onChange}
          placeholder={placeholder}
          placeholderTextColor={voiceState === 'listening' ? color.amber : color.faint}
          editable={!running && !voiceBusy}
          onSubmitEditing={onSend}
          returnKeyType="default"
          blurOnSubmit={false}
          multiline
        />
        {running ? (
          <TouchableOpacity
            style={[styles.action, styles.stop]}
            onPress={onStop}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Stop generating"
          >
            <View style={styles.stopSquare} />
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={[styles.action, canSend ? styles.sendOn : styles.sendOff]}
            onPress={onSend}
            disabled={!canSend}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Send message"
          >
            <Text style={[styles.arrow, !canSend && styles.arrowOff]}>↑</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    paddingHorizontal: space(3),
    paddingTop: space(2),
    paddingBottom: Platform.OS === 'ios' ? space(1) : space(3),
    backgroundColor: color.bg0,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    backgroundColor: color.bg1,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.line,
    paddingLeft: space(1.5),
    paddingRight: space(1.5),
    minHeight: 52,
    gap: space(1.5),
  },
  pillListening: { borderColor: color.amber },
  input: {
    flex: 1,
    color: color.text,
    fontSize: 16,
    maxHeight: 120,
    paddingVertical: space(3.5),
  },
  mic: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.bg2,
  },
  micOn: { backgroundColor: color.amber },
  // A simple capsule-on-stand mic glyph drawn with views — no icon deps.
  micGlyph: {
    width: 10,
    height: 16,
    borderRadius: 5,
    backgroundColor: color.faint,
  },
  micGlyphOn: { backgroundColor: color.bg0 },
  attachGlyph: { color: color.faint, fontSize: 18, fontWeight: '600' },
  attachChip: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: space(2),
    backgroundColor: color.bg1,
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: radius.chip,
    paddingHorizontal: space(3),
    paddingVertical: space(1.5),
    marginBottom: space(2),
    maxWidth: '80%',
  },
  attachText: { color: color.dim, fontSize: 12, flexShrink: 1 },
  attachClear: { color: color.faint, fontSize: 13 },
  action: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendOn: { backgroundColor: color.amber },
  sendOff: { backgroundColor: color.bg2 },
  arrow: { color: color.bg0, fontSize: 20, fontWeight: '700', marginTop: -2 },
  arrowOff: { color: color.faint },
  stop: { backgroundColor: color.bg2, borderWidth: 1, borderColor: color.danger },
  stopSquare: { width: 12, height: 12, borderRadius: 2, backgroundColor: color.danger },
});
