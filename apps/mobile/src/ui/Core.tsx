import React, { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import { usePalette } from '../theme';

/**
 * The Core — Minimus's mark and its heartbeat.
 *
 * A solid disc with a thin ring. The disc is the model: it breathes slowly
 * when idle, beats quickly while thinking, and flashes orange when a tool
 * runs. The ring is the listener: it opens when the mic is live. One mark,
 * every state, no icons. It is drawn with views so it renders at any size
 * without an asset.
 */

export type CoreState = 'idle' | 'thinking' | 'acting' | 'listening' | 'speaking' | 'off';

export function Core({ state = 'idle', size = 28 }: { state?: CoreState; size?: number }): React.JSX.Element {
  const p = usePalette();
  const scale = useRef(new Animated.Value(1)).current;
  const ring = useRef(new Animated.Value(0)).current;
  const flash = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    scale.stopAnimation();
    ring.stopAnimation();
    flash.stopAnimation();
    let loop: Animated.CompositeAnimation | null = null;
    if (state === 'idle') {
      loop = Animated.loop(
        Animated.sequence([
          Animated.timing(scale, { toValue: 1.06, duration: 2200, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
          Animated.timing(scale, { toValue: 1, duration: 2200, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        ]),
      );
      Animated.timing(ring, { toValue: 0, duration: 300, useNativeDriver: true }).start();
      Animated.timing(flash, { toValue: 0, duration: 300, useNativeDriver: true }).start();
    } else if (state === 'thinking') {
      loop = Animated.loop(
        Animated.sequence([
          Animated.timing(scale, { toValue: 0.82, duration: 420, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
          Animated.timing(scale, { toValue: 1.1, duration: 420, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        ]),
      );
      Animated.timing(ring, { toValue: 0, duration: 300, useNativeDriver: true }).start();
      Animated.timing(flash, { toValue: 0, duration: 300, useNativeDriver: true }).start();
    } else if (state === 'acting') {
      loop = Animated.loop(
        Animated.sequence([
          Animated.timing(flash, { toValue: 1, duration: 260, useNativeDriver: true }),
          Animated.timing(flash, { toValue: 0.35, duration: 260, useNativeDriver: true }),
        ]),
      );
      Animated.timing(scale, { toValue: 1, duration: 200, useNativeDriver: true }).start();
    } else if (state === 'listening' || state === 'speaking') {
      loop = Animated.loop(
        Animated.sequence([
          Animated.timing(ring, { toValue: 1, duration: state === 'listening' ? 900 : 500, easing: Easing.out(Easing.quad), useNativeDriver: true }),
          Animated.timing(ring, { toValue: 0.4, duration: state === 'listening' ? 900 : 500, easing: Easing.in(Easing.quad), useNativeDriver: true }),
        ]),
      );
      Animated.timing(scale, { toValue: 1, duration: 200, useNativeDriver: true }).start();
    } else {
      Animated.timing(scale, { toValue: 0.7, duration: 300, useNativeDriver: true }).start();
    }
    loop?.start();
    return () => loop?.stop();
  }, [state, scale, ring, flash]);

  const disc = size * 0.5;
  const discColor = state === 'off' ? p.ink3 : state === 'thinking' ? p.live : p.ink;
  const ringColor = state === 'speaking' ? p.accent : p.live;
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Animated.View
        style={[
          styles.ring,
          {
            width: size,
            height: size,
            borderRadius: size / 2,
            borderColor: ringColor,
            opacity: ring,
            transform: [{ scale: Animated.add(0.7, Animated.multiply(ring, 0.3)) }],
          },
        ]}
      />
      <Animated.View
        style={{
          width: disc,
          height: disc,
          borderRadius: disc / 2,
          backgroundColor: discColor,
          transform: [{ scale }],
        }}
      />
      <Animated.View
        style={{
          position: 'absolute',
          width: disc,
          height: disc,
          borderRadius: disc / 2,
          backgroundColor: p.accent,
          opacity: flash,
          transform: [{ scale }],
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  ring: { position: 'absolute', borderWidth: 1.5 },
});
