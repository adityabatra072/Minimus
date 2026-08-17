import { NativeModules, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { parseAssistantOutput, buildSystemPrompt, policyFor, ALL_TOOL_GROUPS } from '@minimus/agent-core';
import { getToolRegistry } from '../tools';
import { composeRun, teachingPreamble, deferredToolExclusions } from './intent';
import { parseWhen } from './scheduler';
import { useSettingsStore } from '../stores/settingsStore';
import { useToolStore } from '../stores/toolStore';
import { useSessionStore } from '../stores/sessionStore';

/**
 * Deterministic self-tests: everything that can be verified WITHOUT running the
 * model. These catch the regressions that agent beats can only catch slowly
 * (and flakily) — broken tool schemas, storage failures, routing drift, native
 * modules missing on a platform — in under a second.
 *
 * Agent beats (RehearsalScreen) then cover the model-dependent behavior.
 */

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

async function storageRoundTrip(): Promise<string> {
  const key = 'minimus.selftest.probe';
  const value = `probe-${Date.now()}`;
  await AsyncStorage.setItem(key, value);
  const read = await AsyncStorage.getItem(key);
  await AsyncStorage.removeItem(key);
  if (read !== value) throw new Error(`round-trip mismatch: wrote ${value}, read ${read}`);
  return 'read-back matches';
}

function checkRegistry(): string {
  const registry = getToolRegistry();
  const tools = registry.list();
  if (tools.length === 0) throw new Error('registry is empty');
  const seen = new Set<string>();
  for (const t of tools) {
    if (seen.has(t.name)) throw new Error(`duplicate tool name: ${t.name}`);
    seen.add(t.name);
    if (!/^[a-z][a-z0-9_]*$/.test(t.name)) throw new Error(`bad tool name: ${t.name}`);
    if (!t.description || t.description.length < 10) {
      throw new Error(`tool ${t.name} has no usable description`);
    }
    if (!t.parameters || t.parameters.type !== 'object') {
      throw new Error(`tool ${t.name} has no object parameter schema`);
    }
    for (const req of t.parameters.required ?? []) {
      if (!t.parameters.properties?.[req]) {
        throw new Error(`tool ${t.name} requires "${req}" but never declares it`);
      }
    }
  }
  const groups = new Set(tools.map((t) => t.group ?? 'core'));
  return `${tools.length} tools, ${groups.size} groups (${[...groups].sort().join(', ')})`;
}

function checkPromptBudget(): string {
  const registry = getToolRegistry();
  const policy = policyFor('lfm2.5-2.6b');
  const prompt = buildSystemPrompt(registry.list(ALL_TOOL_GROUPS), {
    format: policy.format,
    oneToolPerTurn: policy.oneToolPerTurn,
    preamble: 'You are Minimus, running entirely on this phone.',
  });
  const approxTokens = Math.ceil(prompt.length / 4);
  // Every token here is a token the model cannot spend thinking, and prefill
  // is re-paid every turn. The window is 4096 once the engine honours the
  // requested context (docs/SDK-FINDINGS.md ss5); half of it for the tool set
  // is the line where deliberation gets tight.
  if (approxTokens > 2048) {
    throw new Error(`full tool set costs ~${approxTokens} tokens (budget 2048 of a 4096 window)`);
  }
  return `full tool set ~${approxTokens} tokens of a 4096 window`;
}

function checkRouting(): string {
  // What matters is that the model SEES the tool a request needs. Keyword
  // routing used to decide that from the user's wording and got it wrong on 7
  // of 16 ordinary requests, so the shipping composition exposes everything;
  // these cases assert the exposure, not the guesswork.
  const cases: [string, string[]][] = [
    ['turn on the flashlight', ['device']],
    ['look at tomorrow, find me 90 minutes for the gym', ['schedule']],
    ['how much space have I got left on this phone?', ['device']],
    ['who won the Monaco Grand Prix this year?', ['web']],
    ['let Sam know I am running late', ['comms']],
    ['what did I tell you about Thursday?', ['core']],
  ];
  for (const [prompt, must] of cases) {
    const { toolGroups } = composeRun(prompt);
    for (const g of must) {
      if (!toolGroups.includes(g)) {
        throw new Error(`"${prompt}" never saw group ${g} (got ${toolGroups.join(',')})`);
      }
    }
  }
  if (!teachingPreamble('New rule: when I say wind down, dim the screen')) {
    throw new Error('teaching intent not detected');
  }
  if (teachingPreamble('what time is my meeting')) {
    throw new Error('teaching intent false positive');
  }
  if (!deferredToolExclusions('check again in 3 minutes').includes('set_timer')) {
    throw new Error('deferred intent does not hide set_timer');
  }
  return `${cases.length} routing cases + intent guards`;
}

function checkParsing(): string {
  const tools = getToolRegistry().names();
  const single = parseAssistantOutput("[flashlight(on=True)]", 'pythonic', tools);
  if (single.calls.length !== 1 || single.calls[0]!.name !== 'flashlight') {
    throw new Error('bare pythonic call did not parse');
  }
  const batched = parseAssistantOutput(
    "[flashlight(on=True)][set_brightness(level=0.2)]",
    'pythonic',
    tools,
  );
  if (batched.calls.length !== 2) throw new Error('concatenated call lists did not parse');
  const cancelled = parseAssistantOutput('<think>', 'pythonic', tools);
  if (cancelled.text !== '') throw new Error('unclosed think tag leaked into answer text');
  return 'single, batched, and cancelled-mid-thought shapes';
}

function checkScheduleParsing(): string {
  const now = new Date('2026-08-16T10:00:00');
  const plus = parseWhen('+3', now);
  if (Math.round((plus - now.getTime()) / 60000) !== 3) throw new Error('"+3" is not 3 minutes out');
  const at = parseWhen('18:30', now);
  if (new Date(at).getHours() !== 18) throw new Error('"18:30" did not parse to 18:xx');
  return '"+N" and "HH:MM" forms';
}

async function checkNativeTools(): Promise<string> {
  const mod = (NativeModules as Record<string, unknown>)['MinimusTools'];
  if (!mod) throw new Error(`MinimusTools native module missing on ${Platform.OS}`);
  const expected = ['setTorch', 'setBrightness', 'notify', 'setTimer', 'calendarInsert', 'calendarQuery'];
  const missing = expected.filter((m) => typeof (mod as Record<string, unknown>)[m] !== 'function');
  if (missing.length > 0) throw new Error(`native methods missing: ${missing.join(', ')}`);
  return `${expected.length} native methods bridged`;
}

async function checkCalendarAccess(): Promise<string> {
  const registry = getToolRegistry();
  const tool = registry.get('calendar_query');
  if (!tool) throw new Error('calendar_query not registered');
  const result = await tool.execute({ date: 'today' }, { signal: new AbortController().signal });
  const parsed = typeof result === 'string' ? JSON.parse(result) : result;
  const events = (parsed as { events?: unknown[] }).events ?? [];
  const gaps = (parsed as { free_gaps?: unknown[] }).free_gaps ?? [];
  if (!Array.isArray(events) || !Array.isArray(gaps)) throw new Error('unexpected calendar result shape');
  if (gaps.length === 0) throw new Error('no free gaps today — an all-day event may be counted as busy');
  return `${events.length} events, ${gaps.length} free gaps today`;
}

function checkStores(): string {
  const settings = useSettingsStore.getState();
  const tools = useToolStore.getState();
  const sessions = useSessionStore.getState();
  if (typeof settings.setRequireApprovals !== 'function') throw new Error('settings store not wired');
  if (typeof tools.setDisabled !== 'function') throw new Error('tool store not wired');
  if (typeof sessions.appendToActive !== 'function') throw new Error('session store not wired');
  if (!sessions.activeSessionId) throw new Error('no active session id');
  return `settings, tools, ${sessions.sessions.length} saved sessions`;
}

const CHECKS: { name: string; run: () => string | Promise<string> }[] = [
  { name: 'Tool registry integrity', run: checkRegistry },
  { name: 'Prompt budget', run: checkPromptBudget },
  { name: 'Intent routing + guards', run: checkRouting },
  { name: 'Tool-call parsing', run: checkParsing },
  { name: 'Schedule parsing', run: checkScheduleParsing },
  { name: 'Native tool module', run: checkNativeTools },
  { name: 'Persistent storage', run: storageRoundTrip },
  { name: 'Stores wired', run: checkStores },
  { name: 'Calendar access', run: checkCalendarAccess },
];

export async function runSelfTests(
  onResult?: (result: CheckResult) => void,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of CHECKS) {
    let result: CheckResult;
    try {
      const detail = await check.run();
      result = { name: check.name, ok: true, detail };
    } catch (err) {
      result = {
        name: check.name,
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
    results.push(result);
    onResult?.(result);
  }
  return results;
}
