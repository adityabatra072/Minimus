import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenAIAdapter, policyFor } from '@minimus/agent-core';
import { parseSuite } from './scenario.js';
import { runScenario } from './runner.js';

/**
 * Dump every event (including raw text deltas) for ONE scenario — for
 * diagnosing why a model fails it.
 *
 *   npx tsx packages/eval/src/debug.ts <scenario-id> [--model id] [--endpoint url]
 */

const argv = process.argv.slice(2);
const scenarioId = argv[0];
if (!scenarioId) {
  console.error('usage: debug.ts <scenario-id> [--model id] [--endpoint url] [--suite name]');
  process.exit(1);
}
let model = 'lfm2.5-2.6b';
let endpoint = 'http://127.0.0.1:8080/v1';
let suiteName = 'demo';
for (let i = 1; i < argv.length; i++) {
  if (argv[i] === '--model') model = argv[++i]!;
  else if (argv[i] === '--endpoint') endpoint = argv[++i]!;
  else if (argv[i] === '--suite') suiteName = argv[++i]!;
}

const here = dirname(fileURLToPath(import.meta.url));
const suite = parseSuite(readFileSync(resolve(here, '..', 'suites', `${suiteName}.yaml`), 'utf8'));
const scenario = suite.scenarios.find((s) => s.id === scenarioId);
if (!scenario) {
  console.error(`scenario not found: ${scenarioId}`);
  process.exit(1);
}

const adapter = new OpenAIAdapter({ baseUrl: endpoint, model }, model);
const result = await runScenario(scenario, adapter, 1, { policy: policyFor(model) });

let rawText = '';
for (const ev of result.events) {
  switch (ev.type) {
    case 'text_delta':
      rawText += ev.text;
      break;
    case 'turn_started':
      if (rawText) {
        console.log('RAW OUTPUT:', JSON.stringify(rawText));
        rawText = '';
      }
      console.log(`\n===== turn ${ev.turn} =====`);
      break;
    default: {
      if (rawText) {
        console.log('RAW OUTPUT:', JSON.stringify(rawText));
        rawText = '';
      }
      const { type, ...rest } = ev;
      console.log(type, JSON.stringify(rest).slice(0, 400));
    }
  }
}
console.log('\npass:', result.pass, 'failures:', result.failures);
