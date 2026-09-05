import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ToolContext, ToolDefinition, ToolRegistry } from '@minimus/agent-core';

/**
 * User-taught verbs. "New rule: when I say wind down, dim the screen, kill the
 * flashlight and remind me to set an alarm" → the model records that as a
 * MACRO: an ordered list of concrete tool calls, stored on the phone. Saying
 * "wind down" later replays them.
 *
 * Why structured steps instead of letting the model redo the work each time:
 * a 2.6B model takes a slow turn per tool call, and multi-step sequences are
 * exactly where small models drift. Recording once and replaying
 * deterministically makes a taught verb both instant and reliable — and it is
 * still authored entirely by the user, in their own words, out loud.
 */

const KEY = 'minimus.macros.v1';

export interface MacroStep {
  tool: string;
  arguments: Record<string, unknown>;
}

export interface Macro {
  name: string;
  steps: MacroStep[];
  createdAt: string;
}

let registryRef: (() => ToolRegistry) | null = null;

/** Wired by the tool registry builder so macros can execute other tools. */
export function bindMacroRegistry(getRegistry: () => ToolRegistry): void {
  registryRef = getRegistry;
}

export async function loadMacros(): Promise<Macro[]> {
  const raw = await AsyncStorage.getItem(KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as Macro[];
  } catch {
    return [];
  }
}

async function saveMacros(macros: Macro[]): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(macros));
}

/** Settings UI: un-teach a phrase. */
export async function removeMacro(name: string): Promise<void> {
  const macros = (await loadMacros()).filter((m) => normalize(m.name) !== normalize(name));
  await saveMacros(macros);
}

function normalize(name: string): string {
  return name.trim().toLowerCase();
}

export function macroTools(): ToolDefinition[] {
  return [
    {
      name: 'define_macro',
      kind: 'action',
      group: 'macro',
      description:
        'Record a phrase the user is teaching you, together with the actions it should perform later. Recording only — the actions do NOT happen now.',
      usageHint:
        'When the user says "when I say X, …" or "new rule: …" they are TEACHING you a phrase, not asking you to act now. Do NOT perform the actions. Call define_macro once with name="X" and every step in the list.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'the phrase the user will say, e.g. "wind down"' },
          steps: {
            type: 'array',
            description:
              'ordered tool calls, each {"tool": "<tool name>", "arguments": {…}} — use the same tools and parameters you would call directly',
            items: { type: 'object' },
          },
        },
        required: ['name', 'steps'],
      },
      execute: async (args) => {
        const name = normalize(String(args['name'] ?? ''));
        if (!name) throw new Error('name must not be empty');
        const rawSteps = args['steps'];
        if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
          throw new Error('steps must be a non-empty array of {"tool", "arguments"} objects');
        }
        const registry = registryRef?.();
        const steps: MacroStep[] = [];
        for (const raw of rawSteps) {
          const step = raw as { tool?: unknown; name?: unknown; arguments?: unknown; args?: unknown };
          const tool = String(step.tool ?? step.name ?? '').trim();
          if (!tool) throw new Error('each step needs a "tool" name');
          if (registry && !registry.get(tool)) {
            throw new Error(
              `Unknown tool "${tool}" in step. Available tools: ${registry.names().join(', ')}.`,
            );
          }
          const stepArgs = (step.arguments ?? step.args ?? {}) as Record<string, unknown>;
          steps.push({ tool, arguments: stepArgs });
        }
        const macros = (await loadMacros()).filter((m) => m.name !== name);
        macros.push({ name, steps, createdAt: new Date().toISOString().slice(0, 10) });
        await saveMacros(macros);
        return { ok: true, learned: name, step_count: steps.length };
      },
    },
    {
      name: 'run_macro',
      kind: 'action',
      group: 'macro',
      description: 'Run a phrase the user taught earlier (performs all of its actions)',
      usageHint:
        'If the user says a short phrase they previously taught you, call run_macro with that phrase — do not perform the actions individually.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'the taught phrase, e.g. "wind down"' },
        },
        required: ['name'],
      },
      execute: async (args, ctx: ToolContext) => {
        const name = normalize(String(args['name'] ?? ''));
        const macros = await loadMacros();
        const macro = macros.find((m) => m.name === name);
        if (!macro) {
          const known = macros.map((m) => m.name).join(', ');
          throw new Error(
            known ? `No macro called "${name}". Known: ${known}.` : 'No macros have been taught yet.',
          );
        }
        const registry = registryRef?.();
        if (!registry) throw new Error('tool registry unavailable');
        const performed: { tool: string; ok: boolean; detail?: string }[] = [];
        for (const step of macro.steps) {
          const tool = registry.get(step.tool);
          if (!tool) {
            performed.push({ tool: step.tool, ok: false, detail: 'tool not available' });
            continue;
          }
          // Replay executes tools directly, which means it does not pass the
          // approval card the agent loop puts in front of anything that sends
          // on the user's behalf. A taught phrase must not become the way
          // around that gate: "when I say goodnight, text my wife" would fire
          // silently. Refuse the step and say so.
          if (registry.requiresApproval({ id: 'macro', name: step.tool, arguments: step.arguments })) {
            performed.push({
              tool: step.tool,
              ok: false,
              detail: 'needs your confirmation, so it cannot run inside a taught phrase',
            });
            continue;
          }
          try {
            await tool.execute(step.arguments, ctx);
            performed.push({ tool: step.tool, ok: true });
          } catch (err) {
            performed.push({
              tool: step.tool,
              ok: false,
              detail: err instanceof Error ? err.message : String(err),
            });
          }
        }
        return { ok: true, macro: macro.name, performed };
      },
    },
  ];
}
