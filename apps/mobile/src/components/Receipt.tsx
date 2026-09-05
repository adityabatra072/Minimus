import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { font, radius, space, usePalette } from '../theme';
import { LiveDot } from './LiveDot';

/**
 * The receipt — Minimus's signature element. Every tool the agent runs is a
 * line on a small printed slip: what it did, what came back, and at the
 * bottom what the whole run cost in steps and seconds. Raw tool syntax never
 * appears; every line is phrased for a person.
 */

export interface Operation {
  id: string;
  verb: string;
  status: 'running' | 'ok' | 'error' | 'denied' | 'reflex';
  result?: string;
}

export interface ReceiptFooter {
  seconds: number;
  steps: number;
  /** Decode speed of the last generation, tokens per second. */
  tps?: number;
  /** 'device' | 'cloud' | 'reflex' */
  via: string;
  model?: string;
  /** Router decision and its cost, e.g. "calendar · 0.8 s". */
  route?: string;
}

export function Receipt({ ops, footer }: { ops: Operation[]; footer?: ReceiptFooter }): React.JSX.Element | null {
  const p = usePalette();
  if (ops.length === 0 && !footer) return null;
  return (
    <View style={[styles.slip, { backgroundColor: p.surface, borderColor: p.line }]}>
      {ops.map((op, i) => (
        <View key={op.id} style={[styles.row, i > 0 && { borderTopColor: p.line, borderTopWidth: 1 }]}>
          <View style={styles.dotCol}>
            {op.status === 'running' ? (
              <LiveDot />
            ) : (
              <View
                style={[
                  styles.dot,
                  {
                    backgroundColor:
                      op.status === 'ok' ? p.ok : op.status === 'reflex' ? p.accent : op.status === 'denied' ? p.ink3 : p.danger,
                  },
                ]}
              />
            )}
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.verb, { color: op.status === 'running' ? p.live : p.ink }]}>
              {op.verb}
              {op.status === 'running' ? '…' : ''}
            </Text>
            {op.result && op.status !== 'running' ? (
              <Text
                style={[
                  styles.result,
                  { color: op.status === 'error' ? p.danger : op.status === 'denied' ? p.ink3 : p.ink2 },
                  op.status === 'denied' && { fontStyle: 'italic' },
                ]}
                numberOfLines={3}
              >
                {op.result}
              </Text>
            ) : null}
          </View>
          {op.status === 'reflex' ? <Text style={[styles.tag, { color: p.accent, borderColor: p.accent }]}>instant</Text> : null}
        </View>
      ))}
      {footer ? (
        <View style={[styles.footer, { borderTopColor: p.line, backgroundColor: p.surface2 }]}>
          <Text style={[styles.footerText, { color: p.ink3 }]}>
            {footer.steps} step{footer.steps === 1 ? '' : 's'} · {footer.seconds.toFixed(1)} s
            {footer.tps ? ` · ${footer.tps.toFixed(0)} tok/s` : ''} · {footer.via}
            {footer.model ? ` · ${footer.model}` : ''}
            {footer.route ? `\nroute: ${footer.route}` : ''}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  slip: {
    borderWidth: 1,
    borderRadius: radius.md,
    overflow: 'hidden',
    marginTop: space(2),
    alignSelf: 'stretch',
  },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: space(2.5), paddingHorizontal: space(3.5), paddingVertical: space(2.5) },
  dotCol: { width: 10, paddingTop: 5, alignItems: 'center' },
  dot: { width: 7, height: 7, borderRadius: 4 },
  verb: { fontSize: 14, fontWeight: '600', lineHeight: 19, letterSpacing: -0.1 },
  result: { fontFamily: font.mono, fontSize: 12, lineHeight: 17, marginTop: 2 },
  tag: { fontFamily: font.mono, fontSize: 9, letterSpacing: 1, textTransform: 'uppercase', borderWidth: 1, borderRadius: 4, paddingHorizontal: 5, paddingVertical: 2, marginTop: 3 },
  footer: { borderTopWidth: 1, paddingHorizontal: space(3.5), paddingVertical: space(1.75) },
  footerText: { fontFamily: font.mono, fontSize: 11, letterSpacing: 0.3 },
});
