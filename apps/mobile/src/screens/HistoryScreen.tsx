import React from 'react';
import { FlatList, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSessionStore } from '../stores/sessionStore';
import { color, font, radius, space } from '../theme';

/** Saved conversations — tap to reopen, ✕ to delete. Newest first. */

export default function HistoryScreen({
  onClose,
  onPick,
}: {
  onClose: () => void;
  onPick: (sessionId: string) => void;
}): React.JSX.Element {
  const sessions = useSessionStore((s) => s.sessions);
  const deleteSession = useSessionStore((s) => s.deleteSession);

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.title}>Chats</Text>
        <TouchableOpacity onPress={onClose} hitSlop={12}>
          <Text style={styles.close}>Done</Text>
        </TouchableOpacity>
      </View>

      {sessions.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>No saved chats yet.</Text>
        </View>
      ) : (
        <FlatList
          data={sessions}
          keyExtractor={(s) => s.id}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <TouchableOpacity style={styles.row} onPress={() => onPick(item.id)}>
              <View style={styles.rowMain}>
                <Text style={styles.rowTitle} numberOfLines={1}>
                  {item.title}
                </Text>
                <Text style={styles.rowMeta}>
                  {new Date(item.updatedAtMs).toLocaleString()} · {item.messageCount} messages
                </Text>
              </View>
              <TouchableOpacity hitSlop={10} onPress={() => deleteSession(item.id)}>
                <Text style={styles.delete}>✕</Text>
              </TouchableOpacity>
            </TouchableOpacity>
          )}
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
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  emptyText: { color: color.faint, fontSize: 13 },
  list: { padding: space(4), gap: space(2) },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: color.bg1,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: color.line,
    padding: space(3.5),
    gap: space(3),
  },
  rowMain: { flex: 1, gap: space(1) },
  rowTitle: { color: color.text, fontSize: 14, fontWeight: '600' },
  rowMeta: { color: color.faint, fontSize: 11, fontFamily: font.mono },
  delete: { color: color.faint, fontSize: 16 },
});
