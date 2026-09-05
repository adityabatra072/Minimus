import React, { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet } from 'react-native';
import { usePalette } from '../theme';

/** Pulsing live-blue dot: something is happening right now. */
export function LiveDot(): React.JSX.Element {
  const p = usePalette();
  const pulse = useRef(new Animated.Value(0.35)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 600, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.35, duration: 600, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);
  return <Animated.View style={[styles.dot, { opacity: pulse, backgroundColor: p.live }]} />;
}

export function StateDot({ state }: { state: 'ok' | 'error' | 'denied' }): React.JSX.Element {
  const p = usePalette();
  return <Animated.View style={[styles.dot, { backgroundColor: state === 'ok' ? p.ok : state === 'denied' ? p.ink3 : p.danger }]} />;
}

const styles = StyleSheet.create({
  dot: { width: 7, height: 7, borderRadius: 4 },
});
