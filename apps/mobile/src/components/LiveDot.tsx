import React, { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet } from 'react-native';
import { color } from '../theme';

/** Pulsing cyan dot — the ONLY place cyan appears. Running means alive. */
export function LiveDot(): React.JSX.Element {
  const pulse = useRef(new Animated.Value(0.35)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 650,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0.35,
          duration: 650,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);
  return <Animated.View style={[styles.dot, { opacity: pulse }]} />;
}

export function StateDot({ state }: { state: 'ok' | 'error' | 'denied' }): React.JSX.Element {
  return (
    <Animated.View
      style={[
        styles.dot,
        {
          backgroundColor:
            state === 'ok' ? color.ok : state === 'denied' ? color.faint : color.danger,
        },
      ]}
    />
  );
}

const styles = StyleSheet.create({
  dot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: color.cyan,
  },
});
