import { Platform, useColorScheme } from 'react-native';

/**
 * Minimus design tokens — "paper instrument".
 *
 * The app is a small machine that lives in your phone and does things for
 * you. The look borrows from well-made physical instruments rather than from
 * chat apps: a warm paper ground, ink-black type, one signal orange reserved
 * for the moments the agent ACTS on the world, and a monospaced instrument
 * voice for anything that is a reading (speeds, steps, statuses). Dark mode is
 * the same instrument with the lights off: ink ground, paper type.
 *
 * Rules that keep it coherent:
 *  - Orange means "doing". Idle UI is never orange.
 *  - Blue means "alive": the model is thinking or listening right now.
 *  - Green is a settled result; red is a failure. Neither decorates.
 *  - Mono is for readings, never for prose.
 */

export interface Palette {
  /** Page ground. */
  bg: string;
  /** Raised surface: cards, composer. */
  surface: string;
  /** Pressed / tinted surface: user bubbles, chips. */
  surface2: string;
  /** Hairlines. */
  line: string;
  /** Stronger separators and outlines. */
  lineStrong: string;
  /** Primary type. */
  ink: string;
  /** Secondary type. */
  ink2: string;
  /** Tertiary type, timestamps. */
  ink3: string;
  /** Text on the accent. */
  onAccent: string;
  /** Signal orange: the agent acting. */
  accent: string;
  accentSoft: string;
  /** Live blue: thinking / listening. */
  live: string;
  liveSoft: string;
  ok: string;
  okSoft: string;
  danger: string;
  dangerSoft: string;
  /** Warm shadow colour for elevated cards (light only). */
  shadow: string;
}

export const light: Palette = {
  bg: '#F4F1EA',
  surface: '#FFFDF8',
  surface2: '#ECE7DC',
  line: '#E2DCCF',
  lineStrong: '#C9C2B2',
  ink: '#161513',
  ink2: '#5C584F',
  ink3: '#928C7E',
  onAccent: '#FFFFFF',
  accent: '#F4510F',
  accentSoft: '#FDE4D9',
  live: '#1D6BF3',
  liveSoft: '#DCE8FD',
  ok: '#1F8A4C',
  okSoft: '#DDF1E4',
  danger: '#C8321F',
  dangerSoft: '#F9DDD7',
  shadow: '#5A4A2A',
};

export const dark: Palette = {
  bg: '#0E0F12',
  surface: '#17181D',
  surface2: '#22242B',
  line: '#2A2D35',
  lineStrong: '#3A3E49',
  ink: '#F1EDE4',
  ink2: '#A8A39A',
  ink3: '#6E6A63',
  onAccent: '#FFFFFF',
  accent: '#FF6A2B',
  accentSoft: '#3A2116',
  live: '#5B95FF',
  liveSoft: '#172749',
  ok: '#4FC57F',
  okSoft: '#12301E',
  danger: '#FF6A5C',
  dangerSoft: '#3D1B17',
  shadow: '#000000',
};

export function usePalette(): Palette {
  return useColorScheme() === 'dark' ? dark : light;
}

export const font = {
  /** Instrument voice: readings, steps, statuses, small data. */
  mono: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  /** Display: the wordmark and big numbers. System font, heavy. */
  display: Platform.OS === 'ios' ? 'System' : 'sans-serif',
} as const;

export const type = {
  display: { fontSize: 34, fontWeight: '800' as const, letterSpacing: -1 },
  title: { fontSize: 22, fontWeight: '700' as const, letterSpacing: -0.4 },
  heading: { fontSize: 17, fontWeight: '700' as const, letterSpacing: -0.2 },
  body: { fontSize: 16, lineHeight: 24 },
  bodySmall: { fontSize: 14, lineHeight: 20 },
  caption: { fontSize: 12, lineHeight: 16 },
  /** Uppercase mono label, e.g. section headers and eyebrows. */
  label: { fontSize: 11, letterSpacing: 1.4, fontFamily: font.mono, textTransform: 'uppercase' as const },
  reading: { fontSize: 13, fontFamily: font.mono, lineHeight: 18 },
} as const;

export const space = (n: number) => n * 4;

export const radius = {
  xs: 6,
  sm: 10,
  md: 14,
  lg: 20,
  xl: 28,
  pill: 999,
  /** legacy aliases (pre-redesign screens) */
  card: 14,
  chip: 10,
} as const;

/** Soft elevation for cards on the paper ground. */
export const elevation = (p: Palette, level: 1 | 2 = 1) =>
  Platform.OS === 'ios'
    ? {
        shadowColor: p.shadow,
        shadowOpacity: level === 1 ? 0.08 : 0.14,
        shadowRadius: level === 1 ? 10 : 22,
        shadowOffset: { width: 0, height: level === 1 ? 3 : 10 },
      }
    : { elevation: level === 1 ? 2 : 6 };

/**
 * Legacy flat token object kept so screens not yet migrated to `usePalette`
 * keep compiling. Maps onto the DARK palette; the redesign replaces these.
 */
export const color = {
  bg0: dark.bg,
  bg1: dark.surface,
  bg2: dark.surface2,
  line: dark.line,
  text: dark.ink,
  dim: dark.ink2,
  faint: dark.ink3,
  amber: dark.accent,
  amberDeep: '#B84A1C',
  cyan: dark.live,
  danger: dark.danger,
  ok: dark.ok,
} as const;
