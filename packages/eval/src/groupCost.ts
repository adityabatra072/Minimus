/** What each tool group costs in prompt tokens — the real currency of routing. */
import { buildMockTools } from './mockTools.js';
import { buildSystemPrompt } from '@minimus/agent-core';

const { registry } = buildMockTools({});
const groups = ['core', 'device', 'schedule', 'web', 'comms', 'music', 'vision'];
const est = (s: string) => Math.round(s.length / 3.6);
const promptFor = (names: string[]) =>
  buildSystemPrompt(registry.list(names), { format: 'pythonic', oneToolPerTurn: true });

for (const g of groups) {
  console.log(g.padEnd(10), String(registry.list([g]).length).padStart(2), 'tools', String(est(promptFor([g]))).padStart(5), 'tok');
}
console.log('ALL'.padEnd(10), String(registry.list(groups).length).padStart(2), 'tools', String(est(promptFor(groups))).padStart(5), 'tok');
