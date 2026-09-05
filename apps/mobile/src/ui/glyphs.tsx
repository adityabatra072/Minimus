import React from 'react';
import { StyleSheet, View } from 'react-native';

/**
 * Tiny glyphs drawn from views. No icon font, no SVG dependency: the app
 * needs about a dozen marks and each is a couple of rectangles.
 */

type G = { color: string; size?: number };

export function GlyphPlus({ color, size = 16 }: G): React.JSX.Element {
  const t = Math.max(1.5, size / 9);
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ position: 'absolute', width: size, height: t, backgroundColor: color, borderRadius: t }} />
      <View style={{ position: 'absolute', width: t, height: size, backgroundColor: color, borderRadius: t }} />
    </View>
  );
}

export function GlyphX({ color, size = 14 }: G): React.JSX.Element {
  const t = Math.max(1.5, size / 9);
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ position: 'absolute', width: size, height: t, backgroundColor: color, borderRadius: t, transform: [{ rotate: '45deg' }] }} />
      <View style={{ position: 'absolute', width: size, height: t, backgroundColor: color, borderRadius: t, transform: [{ rotate: '-45deg' }] }} />
    </View>
  );
}

export function GlyphArrowUp({ color, size = 16 }: G): React.JSX.Element {
  const t = Math.max(1.5, size / 8);
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ position: 'absolute', width: t, height: size * 0.85, backgroundColor: color, borderRadius: t, top: size * 0.1 }} />
      <View
        style={{
          position: 'absolute',
          width: size * 0.5,
          height: size * 0.5,
          borderTopWidth: t,
          borderLeftWidth: t,
          borderColor: color,
          top: size * 0.12,
          transform: [{ rotate: '45deg' }],
        }}
      />
    </View>
  );
}

export function GlyphStop({ color, size = 12 }: G): React.JSX.Element {
  return <View style={{ width: size, height: size, borderRadius: 2, backgroundColor: color }} />;
}

export function GlyphMic({ color, size = 16 }: G): React.JSX.Element {
  const w = size * 0.42;
  return (
    <View style={{ width: size, height: size, alignItems: 'center' }}>
      <View style={{ width: w, height: size * 0.58, borderRadius: w / 2, backgroundColor: color }} />
      <View style={{ width: size * 0.7, height: size * 0.3, borderBottomLeftRadius: size * 0.35, borderBottomRightRadius: size * 0.35, borderWidth: 1.5, borderTopWidth: 0, borderColor: color, marginTop: -size * 0.22 }} />
      <View style={{ width: 1.5, height: size * 0.14, backgroundColor: color }} />
    </View>
  );
}

export function GlyphChevron({ color, size = 12, direction = 'right' }: G & { direction?: 'right' | 'left' | 'down' | 'up' }): React.JSX.Element {
  const rot = direction === 'right' ? '45deg' : direction === 'left' ? '-135deg' : direction === 'down' ? '135deg' : '-45deg';
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ width: size * 0.6, height: size * 0.6, borderTopWidth: 1.75, borderRightWidth: 1.75, borderColor: color, transform: [{ rotate: rot }] }} />
    </View>
  );
}

export function GlyphCheck({ color, size = 14 }: G): React.JSX.Element {
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ width: size * 0.7, height: size * 0.38, borderBottomWidth: 2, borderLeftWidth: 2, borderColor: color, transform: [{ rotate: '-45deg' }, { translateY: -size * 0.08 }] }} />
    </View>
  );
}

export function GlyphMenu({ color, size = 16 }: G): React.JSX.Element {
  const t = Math.max(1.5, size / 9);
  return (
    <View style={{ width: size, height: size, justifyContent: 'space-evenly' }}>
      <View style={{ width: size, height: t, backgroundColor: color, borderRadius: t }} />
      <View style={{ width: size * 0.7, height: t, backgroundColor: color, borderRadius: t }} />
    </View>
  );
}

export function GlyphClock({ color, size = 16 }: G): React.JSX.Element {
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, borderWidth: 1.75, borderColor: color, alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ position: 'absolute', width: 1.75, height: size * 0.3, backgroundColor: color, top: size * 0.2 }} />
      <View style={{ position: 'absolute', width: size * 0.25, height: 1.75, backgroundColor: color, left: size / 2 - 1, top: size / 2 - 2 }} />
    </View>
  );
}

export const glyphStyles = StyleSheet.create({});
