import React from 'react';
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSessionStore } from '../stores/sessionStore';
import { font, radius, space, usePalette } from '../theme';
import { Header, Label, Screen } from '../ui/primitives';
import { GlyphX } from '../ui/glyphs';

/** Saved conversations — tap to reopen, × to delete. Newest first. */

function when(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `today ${time}`;
  if (d.toDateString() === yesterday.toDateString()) return `yesterday ${time}`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ` ${time}`;
}

export default function HistoryScreen({ onClose, onPick }: { onClose: () => void; onPick: (sessionId: string) => void }): React.JSX.Element {
  const p = usePalette();
  const sessions = useSessionStore((s) => s.sessions);
  const active = useSessionStore((s) => s.activeSessionId);
  const deleteSession = useSessionStore((s) => s.deleteSession);

  return (
    <Screen>
      <Header title="Chats" eyebrow={`${sessions.length} on this phone`} onClose={onClose} />
      {sessions.length === 0 ? (
        <View style={styles.empty}>
          <Text style={[styles.emptyText, { color: p.ink3 }]}>Nothing saved yet. Conversations land here as you go.</Text>
        </View>
      ) : (
        <FlatList
          data={sessions}
          keyExtractor={(s) => s.id}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <Pressable
              style={({ pressed }) => [
                styles.row,
                { backgroundColor: pressed ? p.surface2 : p.surface, borderColor: item.id === active ? p.ink : p.line },
              ]}
              onPress={() => onPick(item.id)}
            >
              <View style={{ flex: 1, gap: 3 }}>
                <Text style={[styles.title, { color: p.ink }]} numberOfLines={2}>
                  {item.title}
                </Text>
                <Text style={[styles.meta, { color: p.ink3 }]}>
                  {when(item.updatedAtMs)} · {item.messageCount} message{item.messageCount === 1 ? '' : 's'}
                  {item.id === active ? ' · open' : ''}
                </Text>
              </View>
              <Pressable
                hitSlop={12}
                accessibilityRole="button"
                accessibilityLabel="Delete chat"
                onPress={() =>
                  Alert.alert('Delete this chat?', item.title, [
                    { text: 'Cancel', style: 'cancel' },
                    { text: 'Delete', style: 'destructive', onPress: () => deleteSession(item.id) },
                  ])
                }
              >
                <GlyphX color={p.ink3} size={12} />
              </Pressable>
            </Pressable>
          )}
          ListHeaderComponent={<Label style={{ marginBottom: space(2) }}>newest first</Label>}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space(8) },
  emptyText: { fontSize: 14, textAlign: 'center', lineHeight: 20 },
  list: { paddingHorizontal: space(4), paddingBottom: space(10), gap: space(2) },
  row: { flexDirection: 'row', alignItems: 'center', gap: space(3), borderWidth: 1, borderRadius: radius.lg, padding: space(4) },
  title: { fontSize: 15, fontWeight: '600', letterSpacing: -0.2, lineHeight: 20 },
  meta: { fontSize: 11, fontFamily: font.mono },
});
