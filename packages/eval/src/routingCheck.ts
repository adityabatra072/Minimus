/**
 * Does the router even SHOW the model the tool the task needs?
 *
 * A scenario can only fail two ways: the model chose badly, or it never saw
 * the right tool. The second is a routing bug and needs no model to find, so
 * this check runs the shipping composition over every scenario in a suite and
 * reports the ones whose expected tool was never exposed. Those are pure
 * overfitting to the demo wording — the model was never given a chance.
 *
 *   npx tsx packages/eval/src/routingCheck.ts [suite]
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { composeRun } from '@minimus/agent-core';
import { buildMockTools } from './mockTools.js';
import { parseSuite } from './scenario.js';

const here = dirname(fileURLToPath(import.meta.url));
const suiteName = process.argv[2] ?? 'general';
const suite = parseSuite(
  readFileSync(join(here, '..', 'suites', `${suiteName}.yaml`), 'utf8'),
);

const { registry } = buildMockTools({});
let holes = 0;

for (const s of suite.scenarios) {
  const expected = (s.expect.calls ?? []).map((c) => c.tool);
  if (expected.length === 0) continue;
  const { toolGroups, excludeTools } = s.route
    ? composeRun(s.prompt, { macroNames: s.macros ?? [] })
    : { toolGroups: s.tools ?? [], excludeTools: s.exclude_tools ?? [] };
  const exposed = new Set(
    registry
      .list(toolGroups)
      .map((t) => t.name)
      .filter((n) => !excludeTools.includes(n)),
  );
  const missing = expected.filter((t) => !exposed.has(t));
  if (missing.length > 0) {
    holes++;
    console.log(`HOLE  ${s.id}`);
    console.log(`      "${s.prompt}"`);
    console.log(`      needs ${missing.join(', ')} — routed to [${toolGroups.join(', ')}]`);
  }
}

console.log(
  holes === 0
    ? `routing: every expected tool is exposed across ${suite.scenarios.length} scenarios`
    : `routing: ${holes} scenario(s) never saw the tool they need`,
);
process.exit(holes === 0 ? 0 : 1);
