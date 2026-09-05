import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MockAdapter } from '@minimus/agent-core';
import { parseSuite } from '../src/scenario.js';
import { runScenario, runSuite } from '../src/runner.js';
import { buildMockTools, callsSatisfy, matchesExpectedArgs } from '../src/mockTools.js';

const here = dirname(fileURLToPath(import.meta.url));
const demoSuite = () => parseSuite(readFileSync(resolve(here, '..', 'suites', 'demo.yaml'), 'utf8'));

describe('suite parsing', () => {
  it('parses the demo suite', () => {
    const suite = demoSuite();
    expect(suite.suite).toBe('demo');
    expect(suite.scenarios.length).toBeGreaterThanOrEqual(10);
  });
});

describe('arg matching', () => {
  it('matches exact, regex and array values', () => {
    expect(matchesExpectedArgs({ on: true }, { on: true })).toBe(true);
    expect(matchesExpectedArgs({ app: 'Spotify Music' }, { app: { re: 'spotify' } })).toBe(true);
    expect(matchesExpectedArgs({ days: ['mon'] }, { days: ['mon'] })).toBe(true);
    expect(matchesExpectedArgs({ on: false }, { on: true })).toBe(false);
  });

  it('callsSatisfy enforces ordered subsequence', () => {
    const rec = [
      { name: 'web_search', arguments: { query: 'drake latest' } },
      { name: 'fetch_page', arguments: { url: 'x' } },
      { name: 'play_music', arguments: { query: 'Night Mode' } },
    ];
    expect(
      callsSatisfy(rec, [
        { tool: 'web_search' },
        { tool: 'play_music', args: { query: { re: 'night' } } },
      ]),
    ).toBe(true);
    expect(callsSatisfy(rec, [{ tool: 'play_music' }, { tool: 'web_search' }])).toBe(false);
  });
});

describe('runScenario', () => {
  it('passes the flashlight scenario with a well-behaved mock model', async () => {
    const suite = demoSuite();
    const scenario = suite.scenarios.find((s) => s.id === 'flashlight-on')!;
    const adapter = new MockAdapter(['[flashlight(on=True)]', 'Flashlight is on.'], 'mock-lfm');
    const result = await runScenario(scenario, adapter, 1, {});
    expect(result.failures).toEqual([]);
    expect(result.pass).toBe(true);
  });

  it('fails when the model calls the wrong tool', async () => {
    const suite = demoSuite();
    const scenario = suite.scenarios.find((s) => s.id === 'flashlight-on')!;
    const adapter = new MockAdapter(['[set_brightness(level=1)]', 'Done.'], 'mock-lfm');
    const result = await runScenario(scenario, adapter, 1, {});
    expect(result.pass).toBe(false);
    expect(result.failures.join(' ')).toContain('flashlight');
  });

  it('scores a multi-scenario suite', async () => {
    const suite = {
      suite: 'mini',
      scenarios: [
        demoSuite().scenarios.find((s) => s.id === 'flashlight-on')!,
        demoSuite().scenarios.find((s) => s.id === 'no-tool-creative')!,
      ],
    };
    // One adapter per attempt isn't supported by MockAdapter's single script,
    // so script both scenarios' turns in order.
    const adapter = new MockAdapter(
      ['[flashlight(on=True)]', 'On.', 'Peaks hold the sky in silence,\nsnow keeps their secrets.'],
      'mock-lfm',
    );
    const report = await runSuite(suite, adapter, {});
    expect(report.passRate).toBe(1);
    expect(report.scenarioPassRates['flashlight-on']).toBe(1);
  });
});
