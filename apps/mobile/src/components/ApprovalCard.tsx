import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { color, font, radius, space } from '../theme';

/**
 * Inline confirmation for side-effecting actions (email, SMS, calls).
 * A card in the conversation, not a system alert — the run visibly pauses
 * and waits, which is the trust story of the demo.
 */
export function ApprovalCard({
  title,
  detail,
  onDecision,
}: {
  title: string;
  detail: string;
  onDecision: (approved: boolean) => void;
}): React.JSX.Element {
  return (
    <View style={styles.card}>
      <Text style={styles.eyebrow}>needs your ok</Text>
      <Text style={styles.title}>{title}</Text>
      {detail ? <Text style={styles.detail}>{detail}</Text> : null}
      <View style={styles.row}>
        <TouchableOpacity style={styles.deny} onPress={() => onDecision(false)}>
          <Text style={styles.denyText}>Don’t</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.allow} onPress={() => onDecision(true)}>
          <Text style={styles.allowText}>Do it</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: color.bg1,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: color.amberDeep,
    padding: space(4),
    marginVertical: space(2),
    gap: space(1.5),
  },
  eyebrow: {
    color: color.amber,
    fontFamily: font.mono,
    fontSize: 11,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  title: { color: color.text, fontSize: 15, fontWeight: '600' },
  detail: { color: color.dim, fontSize: 13, lineHeight: 19 },
  row: { flexDirection: 'row', gap: space(2), marginTop: space(2) },
  deny: {
    flex: 1,
    paddingVertical: space(2.5),
    borderRadius: radius.chip,
    borderWidth: 1,
    borderColor: color.line,
    alignItems: 'center',
  },
  denyText: { color: color.dim, fontWeight: '600', fontSize: 14 },
  allow: {
    flex: 1,
    paddingVertical: space(2.5),
    borderRadius: radius.chip,
    backgroundColor: color.amber,
    alignItems: 'center',
  },
  allowText: { color: color.bg0, fontWeight: '700', fontSize: 14 },
});
