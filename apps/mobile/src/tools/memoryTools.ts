import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ToolDefinition } from '@minimus/agent-core';

/**
 * On-device memory — the "personal context" tools. Everything lives in
 * AsyncStorage on this phone; recall works with the radio off. This is the
 * demo Apple advertised and settled a lawsuit over instead of shipping:
 * "what was the restaurant Sarah recommended?" — answered locally.
 *
 * v1 is a plain fact store the model reads in full (facts are short and few
 * in a demo); embedding search can come later without changing the schema.
 */

const KEY = 'minimus.memories.v1';

interface Memory {
  id: string;
  text: string;
  savedAt: string; // ISO date
}

async function loadAll(): Promise<Memory[]> {
  const raw = await AsyncStorage.getItem(KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as Memory[];
  } catch {
    return [];
  }
}

async function saveAll(memories: Memory[]): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(memories));
}

export function memoryTools(): ToolDefinition[] {
  return [
    {
      name: 'remember',
      group: 'core',
      description: 'Save a fact to on-device memory so it can be recalled later (stays on this phone)',
      parameters: {
        type: 'object',
        properties: {
          fact: {
            type: 'string',
            description: 'the fact to remember, phrased plainly, e.g. "Sarah recommended Trattoria Da Enzo in Rome"',
          },
        },
        required: ['fact'],
      },
      execute: async (args) => {
        const fact = String(args['fact']).trim();
        if (!fact) throw new Error('fact must not be empty');
        const memories = await loadAll();
        memories.push({
          id: `m_${Date.now().toString(36)}`,
          text: fact,
          savedAt: new Date().toISOString().slice(0, 10),
        });
        await saveAll(memories);
        return { ok: true, remembered: fact, total_memories: memories.length };
      },
    },
    {
      name: 'recall',
      group: 'core',
      description: 'Search on-device memory for previously saved facts',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'what to look for, e.g. "restaurant Sarah" — leave broad, matching is fuzzy',
          },
        },
        required: ['query'],
      },
      execute: async (args) => {
        const query = String(args['query']).toLowerCase();
        const memories = await loadAll();
        if (memories.length === 0) {
          return { matches: [], note: 'No memories saved yet.' };
        }
        const terms = query.split(/\s+/).filter((t) => t.length > 2);
        const scored = memories
          .map((m) => ({
            m,
            score: terms.filter((t) => m.text.toLowerCase().includes(t)).length,
          }))
          .sort((a, b) => b.score - a.score);
        const matches = (scored[0] && scored[0].score > 0 ? scored.filter((s) => s.score > 0) : scored)
          .slice(0, 5)
          .map(({ m }) => ({ fact: m.text, saved: m.savedAt }));
        return { matches };
      },
    },
  ];
}
