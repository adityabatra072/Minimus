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

export interface Memory {
  id: string;
  text: string;
  savedAt: string; // ISO date
}

/** Settings UI: everything the agent remembers, oldest first. */
export async function listMemories(): Promise<Memory[]> {
  return loadAll();
}

/** Memory screen: add a fact by hand, same store the agent writes to. */
export async function addMemory(text: string): Promise<Memory> {
  const memories = await loadAll();
  const memory: Memory = { id: `m_${Date.now().toString(36)}`, text: text.trim(), savedAt: new Date().toISOString().slice(0, 10) };
  memories.push(memory);
  await saveAll(memories);
  return memory;
}

export async function removeMemory(id: string): Promise<void> {
  const memories = (await loadAll()).filter((m) => m.id !== id);
  await saveAll(memories);
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

/**
 * Same fuzzy match the recall tool uses, exposed so a message can be checked
 * against memory BEFORE the model runs. Matching facts ride into the context
 * and a memory question is answered without a tool call at all.
 */
export async function matchingFacts(query: string, limit = 3): Promise<string[]> {
  const memories = await loadAll();
  if (memories.length === 0) return [];
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter((t) => t.length > 2 && !STOP.has(t));
  if (terms.length === 0) return [];
  return memories
    .map((m) => ({ m, score: terms.filter((t) => m.text.toLowerCase().includes(t)).length }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ m }) => m.text);
}

const STOP = new Set(['the', 'and', 'what', 'whats', 'that', 'this', 'with', 'for', 'you', 'your', 'did', 'tell', 'about', 'have', 'was', 'were', 'are', 'can', 'please', 'when', 'say', 'ask', 'asked', 'need', 'know', 'remember', 'recall', 'told']);

export function memoryTools(): ToolDefinition[] {
  return [
    {
      name: 'remember',
      kind: 'action',
      group: 'memory',
      description: 'Save a fact to on-device memory so it can be recalled later (stays on this phone)',
      usageHint:
        'remember stores INFORMATION to answer questions later. If the user is instead describing a phrase that should PERFORM actions ("when I say X, do Y and Z", "new rule: …"), that is define_macro, not remember.',
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
      group: 'memory',
      description: 'Search on-device memory for previously saved facts',
      usageHint:
        'recall is for finding saved information. If the user says a phrase they TAUGHT you, that is run_macro, not recall.',
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
