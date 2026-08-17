import {
  AgentLoop,
  composeRun,
  policyFor,
  type AgentEvent,
  type ModelAdapter,
  type ModelPolicy,
} from '@minimus/agent-core';
import { buildMockTools, callsSatisfy } from './mockTools.js';
import type { Scenario, Suite } from './scenario.js';

export interface ScenarioResult {
  id: string;
  attempt: number;
  pass: boolean;
  failures: string[];
  turnsUsed: number;
  toolCallsMade: { name: string; arguments: Record<string, unknown> }[];
  finalText: string;
  events: AgentEvent[];
  durationMs: number;
}

export interface SuiteReport {
  suite: string;
  modelId: string;
  startedAt: string;
  repeats: number;
  results: ScenarioResult[];
  passRate: number;
  scenarioPassRates: Record<string, number>;
}

export interface RunSuiteOptions {
  repeats?: number;
  policy?: ModelPolicy;
  /** Called before each attempt so callers can log progress. */
  onProgress?: (scenarioId: string, attempt: number) => void;
  /** Approval handler defaults to auto-approve (eval measures capability, not UX). */
  autoApprove?: boolean;
}

export async function runScenario(
  scenario: Scenario,
  adapter: ModelAdapter,
  attempt: number,
  options: RunSuiteOptions,
): Promise<ScenarioResult> {
  const { registry, recorded } = buildMockTools(scenario.tool_results ?? {});
  // `route: true` runs the app's own composition, so a routing change that
  // breaks a real request shows up here instead of in a demo.
  const routed = scenario.route
    ? composeRun(scenario.prompt, { macroNames: scenario.macros ?? [] })
    : null;
  const loop = new AgentLoop();
  const events: AgentEvent[] = [];
  const started = Date.now();

  let finalText = '';
  let reason = 'unknown';
  let turnsUsed = 0;
  const runConfig: Parameters<AgentLoop['run']>[1] = {
    adapter,
    tools: registry,
    approvals: async () => options.autoApprove !== false,
    ...(options.policy ? { policy: options.policy } : {}),
    ...(routed
      ? {
          toolGroups: routed.toolGroups,
          excludeTools: routed.excludeTools,
          preamble: routed.preamble,
        }
      : {
          ...(scenario.tools ? { toolGroups: scenario.tools } : {}),
          ...(scenario.exclude_tools ? { excludeTools: scenario.exclude_tools } : {}),
          ...(scenario.preamble ? { preamble: scenario.preamble } : {}),
        }),
  };
  for await (const ev of loop.run(scenario.prompt, runConfig)) {
    events.push(ev);
    if (ev.type === 'turn_finished') turnsUsed = ev.turn + 1;
    if (ev.type === 'run_finished') {
      finalText = ev.finalText;
      reason = ev.reason;
    }
  }

  const failures: string[] = [];
  const exp = scenario.expect;
  if (reason !== 'completed') failures.push(`run ended with reason=${reason}`);
  if (exp.no_calls && recorded.length > 0) {
    failures.push(`expected no tool calls, got ${recorded.map((r) => r.name).join(', ')}`);
  }
  if (exp.calls && !callsSatisfy(recorded, exp.calls)) {
    failures.push(
      `expected calls ${exp.calls.map((c) => c.tool).join(' → ')} not satisfied; actual: ${
        recorded.map((r) => `${r.name}(${JSON.stringify(r.arguments)})`).join(', ') || '(none)'
      }`,
    );
  }
  for (const needle of exp.final_contains ?? []) {
    if (!finalText.toLowerCase().includes(needle.toLowerCase())) {
      failures.push(`final answer missing "${needle}": ${finalText.slice(0, 120)}`);
    }
  }
  if (exp.max_turns !== undefined && turnsUsed > exp.max_turns) {
    failures.push(`used ${turnsUsed} turns > max ${exp.max_turns}`);
  }

  return {
    id: scenario.id,
    attempt,
    pass: failures.length === 0,
    failures,
    turnsUsed,
    toolCallsMade: recorded,
    finalText,
    events,
    durationMs: Date.now() - started,
  };
}

export async function runSuite(
  suite: Suite,
  adapter: ModelAdapter,
  options: RunSuiteOptions = {},
): Promise<SuiteReport> {
  const repeats = options.repeats ?? 1;
  const results: ScenarioResult[] = [];
  for (const scenario of suite.scenarios) {
    for (let attempt = 1; attempt <= repeats; attempt++) {
      options.onProgress?.(scenario.id, attempt);
      results.push(await runScenario(scenario, adapter, attempt, options));
    }
  }
  const scenarioPassRates: Record<string, number> = {};
  for (const s of suite.scenarios) {
    const rs = results.filter((r) => r.id === s.id);
    scenarioPassRates[s.id] = rs.filter((r) => r.pass).length / rs.length;
  }
  return {
    suite: suite.suite,
    modelId: adapter.modelId,
    startedAt: new Date().toISOString(),
    repeats,
    results,
    passRate: results.filter((r) => r.pass).length / results.length,
    scenarioPassRates,
  };
}

export function formatReport(report: SuiteReport, verbose = false): string {
  const lines: string[] = [];
  lines.push(`suite=${report.suite} model=${report.modelId} repeats=${report.repeats}`);
  lines.push(`overall pass rate: ${(report.passRate * 100).toFixed(1)}%`);
  lines.push('');
  for (const [id, rate] of Object.entries(report.scenarioPassRates)) {
    const mark = rate === 1 ? 'PASS' : rate === 0 ? 'FAIL' : 'FLAKY';
    lines.push(`  [${mark}] ${id}: ${(rate * 100).toFixed(0)}%`);
    if (verbose || rate < 1) {
      for (const r of report.results.filter((r) => r.id === id && !r.pass)) {
        for (const f of r.failures) lines.push(`      attempt ${r.attempt}: ${f}`);
      }
    }
  }
  return lines.join('\n');
}
