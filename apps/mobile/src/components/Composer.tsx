import React from 'react';
import {
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { color, radius, space } from '../theme';

export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  running,
}: {
  value: string;
  onChange: (t: string) => void;
  onSend: () => void;
  onStop: () => void;
  running: boolean;
}): React.JSX.Element {
  const canSend = value.trim().length > 0 && !running;
  return (
    <View style={styles.wrap}>
      <View style={styles.pill}>
        <TextInput
          style={styles.input}
          value={value}
          onChangeText={onChange}
          placeholder={running ? 'Working…' : 'Ask me anything'}
          placeholderTextColor={color.faint}
          editable={!running}
          onSubmitEditing={onSend}
          returnKeyType="send"
          multiline={false}
        />
        {running ? (
          <TouchableOpacity style={[styles.action, styles.stop]} onPress={onStop} hitSlop={8}>
            <View style={styles.stopSquare} />
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={[styles.action, canSend ? styles.sendOn : styles.sendOff]}
            onPress={onSend}
            disabled={!canSend}
            hitSlop={8}
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
    alignItems: 'center',
    backgroundColor: color.bg1,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.line,
    paddingLeft: space(4),
    paddingRight: space(1.5),
    height: 52,
  },
  input: { flex: 1, color: color.text, fontSize: 16, paddingVertical: 0 },
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
