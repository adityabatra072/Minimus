import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
  type PressableProps,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { elevation, radius, space, type as t, usePalette, type Palette } from '../theme';

/**
 * The small set of building blocks every screen is made of. Each one reads the
 * palette at render time so light and dark are the same code, and each has one
 * job. Composition happens in the screens.
 */

export function Screen({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }): React.JSX.Element {
  const p = usePalette();
  return <View style={[{ flex: 1, backgroundColor: p.bg }, style]}>{children}</View>;
}

/** Standard secondary-screen header: big title, optional back/close and action. */
export function Header({
  title,
  eyebrow,
  onClose,
  closeLabel = 'Done',
  right,
}: {
  title: string;
  eyebrow?: string;
  onClose?: () => void;
  closeLabel?: string;
  right?: React.ReactNode;
}): React.JSX.Element {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.header, { paddingTop: insets.top + space(2) }]}>
      <View style={{ flex: 1 }}>
        {eyebrow ? <Label>{eyebrow}</Label> : null}
        <Text style={[t.title, { color: p.ink }]}>{title}</Text>
      </View>
      {right}
      {onClose ? (
        <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel={closeLabel}>
          <Text style={[styles.close, { color: p.accent }]}>{closeLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** Uppercase mono eyebrow / section label. */
export function Label({ children, tone = 'muted', style }: { children: React.ReactNode; tone?: 'muted' | 'accent' | 'live' | 'ok' | 'danger'; style?: StyleProp<TextStyle> }): React.JSX.Element {
  const p = usePalette();
  const color = tone === 'accent' ? p.accent : tone === 'live' ? p.live : tone === 'ok' ? p.ok : tone === 'danger' ? p.danger : p.ink3;
  return <Text style={[t.label, { color }, style]}>{children}</Text>;
}

export function Card({ children, style, tone = 'surface', padded = true }: { children: React.ReactNode; style?: StyleProp<ViewStyle>; tone?: 'surface' | 'tint' | 'accent' | 'live' | 'danger' | 'outline'; padded?: boolean }): React.JSX.Element {
  const p = usePalette();
  const bg =
    tone === 'tint' ? p.surface2 : tone === 'accent' ? p.accentSoft : tone === 'live' ? p.liveSoft : tone === 'danger' ? p.dangerSoft : tone === 'outline' ? 'transparent' : p.surface;
  return (
    <View
      style={[
        { backgroundColor: bg, borderRadius: radius.lg, borderWidth: 1, borderColor: tone === 'outline' ? p.lineStrong : p.line },
        tone === 'surface' ? elevation(p, 1) : null,
        padded ? { padding: space(4) } : null,
        style,
      ]}
    >
      {children}
    </View>
  );
}

export type ButtonKind = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Button({
  label,
  kind = 'primary',
  onPress,
  disabled,
  busy,
  small,
  style,
  icon,
}: {
  label: string;
  kind?: ButtonKind;
  onPress?: () => void;
  disabled?: boolean;
  busy?: boolean;
  small?: boolean;
  style?: StyleProp<ViewStyle>;
  icon?: React.ReactNode;
}): React.JSX.Element {
  const p = usePalette();
  const bg = kind === 'primary' ? p.ink : kind === 'danger' ? p.danger : kind === 'secondary' ? p.surface2 : 'transparent';
  const fg = kind === 'primary' || kind === 'danger' ? (kind === 'primary' ? p.bg : p.onAccent) : kind === 'secondary' ? p.ink : p.ink2;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.button,
        small && styles.buttonSmall,
        { backgroundColor: bg, opacity: disabled ? 0.45 : pressed ? 0.75 : 1 },
        kind === 'ghost' && { borderWidth: 1, borderColor: p.lineStrong },
        style,
      ]}
    >
      {busy ? <ActivityIndicator color={fg} size="small" /> : icon}
      <Text style={[styles.buttonText, small && { fontSize: 13 }, { color: fg }]}>{label}</Text>
    </Pressable>
  );
}

/** A small rounded tag; `active` fills it with the ink. */
export function Chip({ label, active, onPress, tone = 'ink', style }: { label: string; active?: boolean; onPress?: () => void; tone?: 'ink' | 'accent' | 'live'; style?: StyleProp<ViewStyle> }): React.JSX.Element {
  const p = usePalette();
  const activeBg = tone === 'accent' ? p.accent : tone === 'live' ? p.live : p.ink;
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      style={({ pressed }) => [
        styles.chip,
        { backgroundColor: active ? activeBg : p.surface, borderColor: active ? activeBg : p.line, opacity: pressed ? 0.75 : 1 },
        style,
      ]}
    >
      <Text style={[styles.chipText, { color: active ? p.bg : p.ink }]}>{label}</Text>
    </Pressable>
  );
}

/** List row: title, optional subtitle and trailing content. */
export function Row({
  title,
  subtitle,
  right,
  onPress,
  first,
  last,
  mono,
}: {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  onPress?: () => void;
  first?: boolean;
  last?: boolean;
  mono?: boolean;
}): React.JSX.Element {
  const p = usePalette();
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: pressed ? p.surface2 : p.surface, borderColor: p.line },
        first && { borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg },
        last && { borderBottomLeftRadius: radius.lg, borderBottomRightRadius: radius.lg, borderBottomWidth: 1 },
      ]}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[t.bodySmall, { color: p.ink, fontWeight: '600' }, mono && t.reading]}>{title}</Text>
        {subtitle ? <Text style={[t.caption, { color: p.ink2 }]}>{subtitle}</Text> : null}
      </View>
      {right ?? (onPress ? <Chevron /> : null)}
    </Pressable>
  );
}

export function Chevron(): React.JSX.Element {
  const p = usePalette();
  return <View style={[styles.chevron, { borderColor: p.ink3 }]} />;
}

export function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }): React.JSX.Element {
  const p = usePalette();
  return (
    <Switch
      value={value}
      onValueChange={onChange}
      trackColor={{ true: p.ink, false: p.surface2 }}
      thumbColor={p.surface}
      ios_backgroundColor={p.surface2}
    />
  );
}

export function Field({ label, style, ...props }: TextInputProps & { label?: string; style?: StyleProp<ViewStyle> }): React.JSX.Element {
  const p = usePalette();
  return (
    <View style={[{ gap: space(1.5) }, style]}>
      {label ? <Label>{label}</Label> : null}
      <TextInput
        placeholderTextColor={p.ink3}
        autoCapitalize="none"
        autoCorrect={false}
        {...props}
        style={[styles.field, { color: p.ink, backgroundColor: p.surface, borderColor: p.line }]}
      />
    </View>
  );
}

export function Segmented<T extends string | number>({ options, value, onChange }: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void }): React.JSX.Element {
  const p = usePalette();
  return (
    <View style={[styles.segment, { backgroundColor: p.surface2 }]}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable key={String(o.value)} onPress={() => onChange(o.value)} style={[styles.segBtn, on && { backgroundColor: p.surface, ...elevation(p, 1) }]}>
            <Text style={[styles.segText, { color: on ? p.ink : p.ink2 }]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Divider({ inset }: { inset?: boolean }): React.JSX.Element {
  const p = usePalette();
  return <View style={{ height: 1, backgroundColor: p.line, marginLeft: inset ? space(4) : 0 }} />;
}

/** A small status dot. */
export function Dot({ tone, size = 8 }: { tone: 'accent' | 'live' | 'ok' | 'danger' | 'muted'; size?: number }): React.JSX.Element {
  const p = usePalette();
  const color = tone === 'accent' ? p.accent : tone === 'live' ? p.live : tone === 'ok' ? p.ok : tone === 'danger' ? p.danger : p.ink3;
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />;
}

/** Icon-only round button (header actions, composer). */
export function IconButton({ children, onPress, label, tone = 'surface', size = 40, disabled, style, ...rest }: PressableProps & { children: React.ReactNode; onPress?: () => void; label: string; tone?: 'surface' | 'ink' | 'accent' | 'live' | 'danger'; size?: number; disabled?: boolean; style?: StyleProp<ViewStyle> }): React.JSX.Element {
  const p = usePalette();
  const bg = tone === 'ink' ? p.ink : tone === 'accent' ? p.accent : tone === 'live' ? p.live : tone === 'danger' ? p.danger : p.surface2;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      style={({ pressed }) => [
        { width: size, height: size, borderRadius: size / 2, backgroundColor: bg, alignItems: 'center', justifyContent: 'center', opacity: disabled ? 0.4 : pressed ? 0.7 : 1 },
        style,
      ]}
      {...rest}
    >
      {children}
    </Pressable>
  );
}

export function useP(): Palette {
  return usePalette();
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    paddingHorizontal: space(5),
    paddingBottom: space(3),
    gap: space(3),
  },
  close: { fontSize: 16, fontWeight: '600', paddingBottom: 3 },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space(2),
    paddingHorizontal: space(5),
    paddingVertical: space(3.5),
    borderRadius: radius.pill,
  },
  buttonSmall: { paddingHorizontal: space(3.5), paddingVertical: space(2) },
  buttonText: { fontSize: 15, fontWeight: '700', letterSpacing: -0.2 },
  chip: {
    paddingHorizontal: space(3),
    paddingVertical: space(1.75),
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  chipText: { fontSize: 13, fontWeight: '600' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space(3),
    paddingHorizontal: space(4),
    paddingVertical: space(3.5),
    borderWidth: 1,
    borderBottomWidth: 0,
  },
  chevron: {
    width: 9,
    height: 9,
    borderTopWidth: 1.5,
    borderRightWidth: 1.5,
    transform: [{ rotate: '45deg' }],
    marginRight: 4,
  },
  field: {
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: space(3.5),
    paddingVertical: space(3),
    fontSize: 15,
  },
  segment: { flexDirection: 'row', borderRadius: radius.md, padding: 3, gap: 2 },
  segBtn: { flex: 1, paddingVertical: space(1.75), borderRadius: radius.sm, alignItems: 'center' },
  segText: { fontSize: 13, fontWeight: '600' },
});
