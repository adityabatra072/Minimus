import React from 'react';
import { StyleSheet, Text } from 'react-native';
import { color, font } from '../theme';

/**
 * Minimal inline markdown for agent prose: **bold**, *italic*, `code`.
 * Small models love bold; full markdown blocks aren't worth the weight here.
 */
export function AgentText({ text }: { text: string }): React.JSX.Element {
  return <Text style={styles.base}>{renderInline(text)}</Text>;
}

function renderInline(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  // Tokenize on **bold**, *italic*, `code` — first match wins, no nesting.
  const re = /(\*\*([^*]+)\*\*|\*([^*\n]+)\*|`([^`\n]+)`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    if (m[2] !== undefined) {
      nodes.push(
        <Text key={key++} style={styles.bold}>
          {m[2]}
        </Text>,
      );
    } else if (m[3] !== undefined) {
      nodes.push(
        <Text key={key++} style={styles.italic}>
          {m[3]}
        </Text>,
      );
    } else if (m[4] !== undefined) {
      nodes.push(
        <Text key={key++} style={styles.code}>
          {m[4]}
        </Text>,
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

const styles = StyleSheet.create({
  base: { color: color.text, fontSize: 16, lineHeight: 24 },
  bold: { fontWeight: '700' },
  italic: { fontStyle: 'italic' },
  code: {
    fontFamily: font.mono,
    fontSize: 14,
    backgroundColor: color.bg2,
    color: color.amber,
  },
});
