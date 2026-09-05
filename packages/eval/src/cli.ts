import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LlamaServerAdapter, OpenAIAdapter, policyFor, type ModelAdapter } from '@minimus/agent-core';
import { parseSuite } from './scenario.js';
import { formatReport, runSuite } from './runner.js';

/**
 * Eval CLI. Talks to any OpenAI-compatible endpoint (llama-server on Windows,
 * rcli serve on mac/linux, runanywhere-python server, cloud).
 *
 *   npm run eval -- --suite demo --endpoint http://127.0.0.1:8080/v1 \
 *     --model lfm2.5-2.6b --repeats 3 --json results/lfm.json
 *
 * `--model` doubles as the policy key (matched against DEFAULT_POLICIES).
 */

interface Args {
  suite: string;
  endpoint: string;
  model: string;
  serverModel?: string;
  repeats: number;
  json?: string;
  verbose: boolean;
  only?: string;
  /** Send the phone's raw ChatML prompt to llama-server /completion instead of chat/completions. */
  raw: boolean;
  toolFormat?: 'compact' | 'lfm-json';
  router: boolean;
  thinking?: 'always' | 'adaptive' | 'adaptive-fast';
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    suite: 'demo',
    endpoint: 'http://127.0.0.1:8080/v1',
    model: 'lfm2.5-2.6b',
    repeats: 1,
    verbose: false,
    raw: false,
    router: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => argv[++i] ?? '';
    if (a === '--suite') args.suite = next();
    else if (a === '--endpoint') args.endpoint = next();
    else if (a === '--model') args.model = next();
    else if (a === '--server-model') args.serverModel = next();
    else if (a === '--repeats') args.repeats = Number(next());
    else if (a === '--json') args.json = next();
    else if (a === '--only') args.only = next();
    else if (a === '--verbose' || a === '-v') args.verbose = true;
    else if (a === '--raw') args.raw = true;
    else if (a === '--router') args.router = true;
    else if (a === '--thinking') args.thinking = next() as 'always' | 'adaptive' | 'adaptive-fast';
    else if (a === '--tool-format') args.toolFormat = next() as 'compact' | 'lfm-json';
    else if (a === '--help' || a === '-h') {
      console.log(
        'usage: eval --suite <name> --endpoint <url> --model <policy-id> [--server-model <name>] [--repeats N] [--only id,id] [--json out.json] [-v]',
      );
      process.exit(0);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const here = dirname(fileURLToPath(import.meta.url));
  const suitePath = resolve(here, '..', 'suites', `${args.suite}.yaml`);
  const suite = parseSuite(readFileSync(suitePath, 'utf8'));
  if (args.only) {
    const wanted = new Set(args.only.split(','));
    suite.scenarios = suite.scenarios.filter((s) => wanted.has(s.id));
    if (suite.scenarios.length === 0) {
      console.error(`no scenarios matched --only ${args.only}`);
      process.exit(1);
    }
  }

  const adapter: ModelAdapter = args.raw
    ? new LlamaServerAdapter({ baseUrl: args.endpoint.replace(/\/v1\/?$/, ''), modelId: args.model })
    : new OpenAIAdapter(
        {
          baseUrl: args.endpoint,
          model: args.serverModel ?? args.model,
          // llama-server: suppress thinking for tool turns when the template supports it.
          extraBody: { chat_template_kwargs: { enable_thinking: false } },
        },
        args.model,
      );

  const policy = { ...policyFor(args.model), ...(args.toolFormat ? { toolFormat: args.toolFormat } : {}), ...(args.thinking ? { thinkingStrategy: args.thinking } : {}) };
  console.log(
    `suite=${args.suite} scenarios=${suite.scenarios.length} model=${args.model} ` +
      `format=${policy.format} endpoint=${args.endpoint} repeats=${args.repeats}`,
  );

  const report = await runSuite(suite, adapter, {
    repeats: args.repeats,
    router: args.router,
    policy,
    onProgress: (id, attempt) => process.stdout.write(`  running ${id} (attempt ${attempt})...\n`),
  });

  console.log('\n' + formatReport(report, args.verbose));

  if (args.json) {
    const out = resolve(args.json);
    mkdirSync(dirname(out), { recursive: true });
    // Strip bulky event streams from the JSON artifact; keep everything else.
    const slim = {
      ...report,
      results: report.results.map(({ events, ...rest }) => ({
        ...rest,
        eventCount: events.length,
      })),
    };
    writeFileSync(out, JSON.stringify(slim, null, 2));
    console.log(`\nwrote ${out}`);
  }

  process.exit(report.passRate === 1 ? 0 : 2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
