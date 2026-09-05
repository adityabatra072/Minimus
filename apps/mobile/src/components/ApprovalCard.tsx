import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { radius, space, usePalette } from '../theme';
import { Button, Label } from '../ui/primitives';

/**
 * Inline confirmation for side-effecting actions (email, SMS, calls, and any
 * tool the user added). A card in the conversation, not a system alert — the
 * run visibly pauses and waits, which is the trust story.
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
  const p = usePalette();
  return (
    <View style={[styles.card, { backgroundColor: p.accentSoft, borderColor: p.accent }]}>
      <Label tone="accent">needs your ok</Label>
      <Text style={[styles.title, { color: p.ink }]}>{title}</Text>
      {detail ? <Text style={[styles.detail, { color: p.ink2 }]}>{detail}</Text> : null}
      <View style={styles.row}>
        <Button label="Not now" kind="ghost" small onPress={() => onDecision(false)} style={{ flex: 1 }} />
        <Button label="Do it" kind="primary" small onPress={() => onDecision(true)} style={{ flex: 1 }} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.lg,
    borderWidth: 1,
    padding: space(4),
    marginVertical: space(2),
    gap: space(1.5),
    alignSelf: 'stretch',
  },
  title: { fontSize: 16, fontWeight: '700', letterSpacing: -0.2 },
  detail: { fontSize: 14, lineHeight: 20 },
  row: { flexDirection: 'row', gap: space(2), marginTop: space(2) },
});
