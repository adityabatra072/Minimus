import { parse } from 'yaml';

/**
 * YAML scenario schema.
 *
 * ```yaml
 * suite: demo
 * scenarios:
 *   - id: flashlight-on
 *     prompt: turn on the flashlight
 *     tools: [device]            # tool groups to expose (core always included)
 *     expect:
 *       calls:                   # ordered subsequence of expected calls
 *         - tool: flashlight
 *           args: { on: true }   # exact match per listed key (extra keys allowed)
 *       final_contains: ["on"]   # optional substring checks on the final answer
 *       max_turns: 3             # optional per-scenario cap on turns used
 * ```
 */

export interface ExpectedCall {
  tool: string;
  /** Per-key expected values; `{re: "..."}` values are treated as regex. */
  args?: Record<string, unknown>;
}

export interface ScenarioExpectation {
  calls?: ExpectedCall[];
  /** When true, the scenario must finish with NO tool calls at all. */
  no_calls?: boolean;
  final_contains?: string[];
  max_turns?: number;
}

export interface Scenario {
  id: string;
  prompt: string;
  /**
   * Derive tool exposure, exclusions and preamble from the SHIPPING router
   * (agent-core composeRun) instead of the hand-written fields below. Prefer
   * this: fields written by hand test the agent we remember writing, and they
   * silently rot when the router changes. `macros` supplies the taught phrases
   * that would be in the user's store at that moment.
   */
  route?: boolean;
  macros?: string[];
  tools?: string[];
  /**
   * Extra system-prompt context the app would inject at this point (e.g. the
   * list of phrases the user has taught). Without it the eval measures a
   * different agent than the one that ships.
   */
  preamble?: string;
  /**
   * Tools the app's intent routing would hide for this prompt (see
   * src/services/intent.ts deferredToolExclusions) — mirror it here or the
   * eval measures a different agent than the one that ships.
   */
  exclude_tools?: string[];
  /** Scripted results keyed by tool name — overrides the mock default. */
  tool_results?: Record<string, unknown>;
  expect: ScenarioExpectation;
}

export interface Suite {
  suite: string;
  scenarios: Scenario[];
}

export function parseSuite(yamlText: string): Suite {
  const doc = parse(yamlText) as Suite;
  if (!doc || !Array.isArray(doc.scenarios)) {
    throw new Error('suite YAML must have a `scenarios` list');
  }
  const seen = new Set<string>();
  for (const s of doc.scenarios) {
    if (!s.id || !s.prompt || !s.expect) {
      throw new Error(`scenario missing id/prompt/expect: ${JSON.stringify(s).slice(0, 120)}`);
    }
    if (seen.has(s.id)) throw new Error(`duplicate scenario id: ${s.id}`);
    seen.add(s.id);
  }
  return doc;
}
