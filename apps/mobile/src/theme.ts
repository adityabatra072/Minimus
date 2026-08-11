import { Platform } from 'react-native';

/**
 * E.V design tokens — "anodize + LED".
 * The palette is the phone itself: anodized blue-black surfaces, one warm
 * LED-amber accent for actions the agent takes on hardware, and a cool signal
 * cyan reserved EXCLUSIVELY for live/running states. If it's not running,
 * it's never cyan.
 */
export const color = {
  bg0: '#0B0D10', // anodize black (page)
  bg1: '#14171C', // raised surface (composer, cards)
  bg2: '#1B1F26', // pressed / user message tint
  line: '#262B33', // hairlines
  text: '#F2EFE8', // warm paper-white
  dim: '#8A919C', // secondary text
  faint: '#565D68', // tertiary / timestamps
  amber: '#FFB454', // action accent — "the LED"
  amberDeep: '#B87718',
  cyan: '#57D7F2', // live/running ONLY
  danger: '#FF6B6B',
  ok: '#7DDB8A',
} as const;

export const font = {
  /** Instrument voice: the action rail, statuses, small data. */
  mono: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
} as const;

export const space = (n: number) => n * 4;

export const radius = {
  pill: 22,
  card: 14,
  chip: 10,
} as const;
