import { Linking } from 'react-native';
import type { ToolDefinition } from '@minimus/agent-core';
import { ddgLiteSearch } from './webTools';

/**
 * Spotify playback that actually plays. The tool — not the model — resolves
 * the query to a concrete track: it searches the public web for the song's
 * open.spotify.com link and opens the matching spotify:track: URI, which
 * Spotify auto-plays. The model just says what to play.
 *
 * Fallback when no track link surfaces: spotify:search:<query> (results page,
 * one tap from playing) — still reported honestly in the result.
 */

const TRACK_RE = /open\.spotify\.com\/(?:intl-[a-z-]+\/)?track\/([A-Za-z0-9]{22})/;
const ALBUM_RE = /open\.spotify\.com\/(?:intl-[a-z-]+\/)?album\/([A-Za-z0-9]{22})/;
const PLAYLIST_RE = /open\.spotify\.com\/(?:intl-[a-z-]+\/)?playlist\/([A-Za-z0-9]{22})/;

interface Resolved {
  uri: string;
  kind: 'track' | 'album' | 'playlist';
  title: string;
}

async function resolveSpotify(query: string, signal: AbortSignal): Promise<Resolved | null> {
  const { results } = await ddgLiteSearch(`${query} spotify track`, signal);
  for (const r of results as { title: string; url: string }[]) {
    const track = TRACK_RE.exec(r.url);
    if (track) return { uri: `spotify:track:${track[1]}`, kind: 'track', title: r.title };
  }
  for (const r of results as { title: string; url: string }[]) {
    const album = ALBUM_RE.exec(r.url);
    if (album) return { uri: `spotify:album:${album[1]}`, kind: 'album', title: r.title };
    const playlist = PLAYLIST_RE.exec(r.url);
    if (playlist) return { uri: `spotify:playlist:${playlist[1]}`, kind: 'playlist', title: r.title };
  }
  return null;
}

function cleanTitle(raw: string): string {
  // DDG titles look like "Janice (STFU) - song and lyrics by ... | Spotify".
  return raw.replace(/\s*[|·-]\s*(song and lyrics by|Spotify|album by|playlist by).*/i, '').trim();
}

export function musicTools(): ToolDefinition[] {
  return [
    {
      name: 'play_music',
      kind: 'action',
      group: 'music',
      description: 'Play a song, album or artist on Spotify (finds the exact track and starts playback)',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'what to play — song and artist work best, e.g. "Janice STFU" or "Night Mode Drake"',
          },
        },
        required: ['query'],
      },
      execute: async (args, ctx) => {
        const query = String(args['query']).trim();
        if (!query) throw new Error('query must not be empty');
        let resolved: Resolved | null = null;
        try {
          resolved = await resolveSpotify(query, ctx.signal);
        } catch {
          resolved = null; // offline or search down — fall through to in-app search
        }
        if (resolved) {
          await Linking.openURL(resolved.uri);
          return {
            ok: true,
            now_playing: cleanTitle(resolved.title) || query,
            kind: resolved.kind,
          };
        }
        await Linking.openURL(`spotify:search:${encodeURIComponent(query)}`);
        return {
          ok: true,
          status: 'opened_spotify_search',
          note: 'Exact track link not found — Spotify search results are showing; playback needs one tap.',
        };
      },
    },
  ];
}
