import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { color, font, space } from '../theme';
import { LiveDot, StateDot } from './LiveDot';

/**
 * The action rail — E.V's signature element. Every tool run is an operation
 * row on a thin vertical rail: instrument evidence of the agent actually
 * doing things, phrased for humans. Raw tool syntax never appears here.
 */

export interface Operation {
  id: string;
  verb: string;
  status: 'running' | 'ok' | 'error' | 'denied';
  result?: string;
}

export function ActionRail({ ops }: { ops: Operation[] }): React.JSX.Element | null {
  if (ops.length === 0) return null;
  return (
    <View style={styles.rail}>
      {ops.map((op) => (
        <View key={op.id} style={styles.row}>
          <View style={styles.dotCol}>
            {op.status === 'running' ? <LiveDot /> : <StateDot state={op.status} />}
          </View>
          <View style={styles.textCol}>
            <Text style={[styles.verb, op.status === 'running' && styles.verbLive]}>
              {op.verb}
              {op.status === 'running' ? '…' : ''}
            </Text>
            {op.result && op.status !== 'running' ? (
              <Text
                style={[
                  styles.result,
                  op.status === 'error' && styles.resultError,
                  op.status === 'denied' && styles.resultDenied,
                ]}
                numberOfLines={2}
              >
                {op.result}
              </Text>
            ) : null}
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  rail: {
    borderLeftWidth: 1,
    borderLeftColor: color.line,
    marginLeft: 3,
    paddingLeft: space(3),
    marginTop: space(2),
    marginBottom: space(1),
    gap: space(2.5),
  },
  row: { flexDirection: 'row', alignItems: 'flex-start', marginLeft: -space(3) - 4 },
  dotCol: { width: space(3) + 4, paddingTop: 5, alignItems: 'flex-start' },
  textCol: { flex: 1 },
  verb: {
    color: color.amber,
    fontFamily: font.mono,
    fontSize: 13,
    lineHeight: 19,
  },
  verbLive: { color: color.cyan },
  result: {
    color: color.dim,
    fontFamily: font.mono,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 1,
  },
  resultError: { color: color.danger },
  resultDenied: { color: color.faint, fontStyle: 'italic' },
});
