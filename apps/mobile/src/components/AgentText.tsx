import React from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { font, radius, space, usePalette } from '../theme';
import { Label } from '../ui/primitives';

/**
 * Agent prose with minimal inline markdown: **bold**, *italic*, `code`, and
 * bullet lines. Small models love bold and lists; full markdown blocks are not
 * worth the weight here.
 */
export function AgentText({ text, live }: { text: string; live?: boolean }): React.JSX.Element {
  const p = usePalette();
  const lines = text.split('\n');
  return (
    <View style={{ gap: 2 }}>
      {lines.map((line, i) => {
        const bullet = /^\s*[-*•]\s+/.test(line);
        const numbered = /^\s*\d+[.)]\s+/.exec(line);
        const content = bullet ? line.replace(/^\s*[-*•]\s+/, '') : numbered ? line.slice(numbered[0].length) : line;
        if (!content.trim() && i > 0 && i < lines.length - 1) return <View key={i} style={{ height: space(1.5) }} />;
        return (
          <View key={i} style={bullet || numbered ? styles.bulletRow : undefined}>
            {bullet ? <Text style={[styles.base, { color: p.ink2 }]}>•</Text> : null}
            {numbered ? <Text style={[styles.base, { color: p.ink2, fontVariant: ['tabular-nums'] }]}>{numbered[0].trim()}</Text> : null}
            <Text style={[styles.base, { color: p.ink, flex: bullet || numbered ? 1 : undefined }]}>
              {renderInline(content, p.surface2, p.ink)}
              {live && i === lines.length - 1 ? <Text style={{ color: p.live }}>▍</Text> : null}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

function renderInline(text: string, codeBg: string, ink: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const re = /(\*\*([^*]+)\*\*|\*([^*\n]+)\*|`([^`\n]+)`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    if (m[2] !== undefined) nodes.push(<Text key={key++} style={styles.bold}>{m[2]}</Text>);
    else if (m[3] !== undefined) nodes.push(<Text key={key++} style={styles.italic}>{m[3]}</Text>);
    else if (m[4] !== undefined) nodes.push(<Text key={key++} style={[styles.code, { backgroundColor: codeBg, color: ink }]}>{m[4]}</Text>);
    last = m.index + m[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/** A faded, collapsible glimpse of what the model is thinking, while it thinks. */
export function ThinkingLine({ text, seconds, done }: { text: string; seconds: number; done?: boolean }): React.JSX.Element {
  const p = usePalette();
  const [open, setOpen] = React.useState(false);
  const tail = text.replace(/\s+/g, ' ').trim();
  const glimpse = tail.length > 90 ? `…${tail.slice(-90)}` : tail;
  return (
    <Pressable onPress={() => setOpen((v) => !v)} style={[styles.think, { borderLeftColor: p.live }]}>
      <Label tone="live">{done ? `thought for ${seconds.toFixed(1)} s` : `thinking · ${seconds.toFixed(0)} s`}</Label>
      {tail ? (
        <Text style={[styles.thinkText, { color: p.ink3 }]} numberOfLines={open ? undefined : 2}>
          {open ? tail : glimpse}
        </Text>
      ) : null}
    </Pressable>
  );
}

export interface Source {
  title: string;
  url: string;
}

export function Sources({ sources }: { sources: Source[] }): React.JSX.Element {
  const p = usePalette();
  return (
    <View style={[styles.sources, { borderColor: p.line, backgroundColor: p.surface }]}>
      <Label>sources</Label>
      {sources.map((s) => (
        <Pressable key={s.url} onPress={() => void Linking.openURL(s.url).catch(() => {})} style={styles.sourceRow}>
          <Text style={[styles.sourceTitle, { color: p.ink }]} numberOfLines={1}>
            {s.title}
          </Text>
          <Text style={[styles.sourceDomain, { color: p.ink3 }]}>{domainOf(s.url)}</Text>
        </Pressable>
      ))}
    </View>
  );
}

export function domainOf(url: string): string {
  const m = /^https?:\/\/(?:www\.)?([^/]+)/i.exec(url);
  return m?.[1] ?? url;
}

const styles = StyleSheet.create({
  base: { fontSize: 16, lineHeight: 24, letterSpacing: -0.1 },
  bulletRow: { flexDirection: 'row', gap: space(2), paddingLeft: space(1) },
  bold: { fontWeight: '700' },
  italic: { fontStyle: 'italic' },
  code: { fontFamily: font.mono, fontSize: 14, borderRadius: 4 },
  think: { borderLeftWidth: 2, paddingLeft: space(3), paddingVertical: space(1), gap: 4, marginTop: space(1) },
  thinkText: { fontSize: 13, lineHeight: 18, fontStyle: 'italic' },
  sources: { borderWidth: 1, borderRadius: radius.md, padding: space(3), gap: space(1.5), marginTop: space(2) },
  sourceRow: { flexDirection: 'row', alignItems: 'baseline', gap: space(2) },
  sourceTitle: { fontSize: 13, flexShrink: 1, fontWeight: '600' },
  sourceDomain: { fontSize: 11, fontFamily: font.mono },
});
