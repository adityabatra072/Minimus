import { AgentLoop } from '@minimus/agent-core';
import { LocalAdapter } from './LocalAdapter';
import { getToolRegistry } from '../tools';
import { loadMacros } from '../tools/macroTools';
import { useModelStore } from '../stores/modelStore';
import { diag } from './diag';
import {
  deferredPreamble,
  deferredToolExclusions,
  macroSteering,
  routeToolGroups,
} from './intent';

/**
 * Runs an agent task with no screen attached.
 *
 * Scheduled tasks must fire wherever the user happens to be — including the
 * Models and Rehearsal screens. The chat screen installs a richer runner while
 * it is mounted (so the audience watches the rail tick); this is the fallback
 * that keeps deferred agency working when it isn't.
 *
 * Side-effecting tools that need consent are DENIED here: nothing should send
 * a message on the user's behalf while they're looking at another screen.
 */
export async function runAgentHeadless(instruction: string): Promise<string> {
  const modelId = useModelStore.getState().activeModelId;
  const macros = await loadMacros().catch(() => []);
  const macroHit = macroSteering(instruction, macros.map((m) => m.name));
  const preamble = [
    'You are Minimus, running entirely on this phone.',
    macros.length > 0
      ? `Phrases the user has taught you (run these with run_macro): ${macros
          .map((m) => `"${m.name}"`)
          .join(', ')}.`
      : '',
    'This is a task you scheduled earlier and it is now due. Carry it out with your tools, then state the outcome in one short sentence.',
    // A scheduled task can itself defer again ("check once more in 10 min") —
    // keep the same steering the foreground screens get.
    deferredPreamble(instruction) ?? '',
    macroHit?.line ?? '',
  ]
    .filter(Boolean)
    .join('\n');

  diag(`headless run start: ${JSON.stringify(instruction.slice(0, 90))}`);
  let finalText = '';
  for await (const ev of new AgentLoop().run(instruction, {
    adapter: new LocalAdapter(modelId),
    tools: getToolRegistry(),
    toolGroups: routeToolGroups(instruction),
    excludeTools: [...deferredToolExclusions(instruction), ...(macroHit?.exclude ?? [])],
    preamble,
    approvals: async () => false,
  })) {
    if (ev.type === 'tool_call_started') diag(`headless tool ${ev.call.name}`);
    if (ev.type === 'run_finished') {
      finalText = ev.finalText;
      diag(`headless run finished reason=${ev.reason}`);
    }
  }
  return finalText;
}
