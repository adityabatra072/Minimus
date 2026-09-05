import { describe, expect, it } from 'vitest';
import { composeRun, extractTaughtPhrase, saidPhrase, clockOffsetHint } from '../src/routing.js';
import { effectiveCategories, parseRouterOutput, routerGrammar } from '../src/router.js';

describe('taught phrases', () => {
  it('matches whole phrases only', () => {
    expect(saidPhrase('Wind down.', ['wind down'])).toBe('wind down');
    expect(saidPhrase('hello', ['hi'])).toBeNull();
    expect(saidPhrase('this is fine', ['hi'])).toBeNull();
    expect(saidPhrase('ok time to wind down now', ['wind down'])).toBe('wind down');
    expect(saidPhrase('the windows are down', ['wind down'])).toBeNull();
  });
  it('only lists taught phrases when one was said', () => {
    expect(composeRun('hello', { macroNames: ['wind down'] }).preamble).not.toContain('wind down');
    expect(composeRun('wind down please', { macroNames: ['wind down'] }).preamble).toContain('wind down');
  });
  it('does not mistake a question about a phrase for a lesson', () => {
    expect(composeRun('what did I ask you to do when I say wind down?', { macroNames: ['wind down'] }).allowExecuteOnly).toBeUndefined();
    expect(composeRun('what did I ask you to do when I say wind down?', { macroNames: ['wind down'] }).denyTools['define_macro']).toBeTruthy();
    expect(composeRun('New rule: when I say wind down, dim the screen', {}).allowExecuteOnly).toEqual(['define_macro']);
    expect(composeRun('when I say wind down, dim the screen and turn the torch off', {}).allowExecuteOnly).toEqual(['define_macro']);
  });
  it('extracts the phrase being taught', () => {
    expect(extractTaughtPhrase('If I ever ask for focus mode, dim the screen')).toBe('focus mode');
    expect(extractTaughtPhrase('Make me a shortcut called bedtime that sets brightness to 10')).toBe('bedtime');
    expect(extractTaughtPhrase('New rule: when I say wind down, set the brightness to 20 percent')).toBe('wind down');
  });
});

describe('router', () => {
  it('parses grammar-shaped output and prose alike', () => {
    expect(parseRouterOutput('phone, later')).toEqual(['phone', 'later']);
    expect(parseRouterOutput('none')).toEqual(['none']);
    expect(parseRouterOutput('The category is: calendar.')).toEqual(['calendar']);
    expect(parseRouterOutput('none, memory')).toEqual(['none']);
    expect(parseRouterOutput('memory, none')).toEqual(['memory']);
    expect(parseRouterOutput('')).toEqual(['none']);
  });
  it('overrules a "none" for an imperative sentence', () => {
    expect(effectiveCategories(['none'], 'turn on the flashlight')).toBeUndefined();
    expect(effectiveCategories(['none'], 'hello there')).toEqual(['none']);
    expect(effectiveCategories(['phone'], 'turn on the flashlight')).toEqual(['phone']);
  });
  it('keeps the tool list constant and gates execution instead', () => {
    const byGroup = { device: ['flashlight', 'device_info'], schedule: ['set_timer', 'schedule_task', 'calendar_create'], memory: ['remember', 'recall'], macro: ['define_macro', 'run_macro'], web: ['web_search'], mcp: ['mcp_slack_post'] };
    const none = composeRun('hello', { categories: ['none'], toolsByGroup: byGroup });
    expect(none.toolGroups.length).toBeGreaterThan(3);
    expect(none.allowExecuteOnly).toEqual([]);
    expect(none.preamble).toContain('needs no tools');
    const cal = composeRun('what have I got on Friday', { categories: ['calendar'], toolsByGroup: byGroup });
    expect(cal.allowExecuteOnly).toEqual(['set_timer', 'schedule_task', 'calendar_create']);
    const deferred = composeRun('in 3 minutes check my battery', { categories: ['phone'], toolsByGroup: byGroup });
    expect(deferred.allowExecuteOnly).toContain('schedule_task');
    expect(deferred.allowExecuteOnly).toContain('device_info');
    expect(deferred.denyTools['set_timer']).toContain('schedule_task');
    const web = composeRun('search it', { categories: ['web'], extraToolGroups: ['mcp'], toolsByGroup: byGroup });
    expect(web.allowExecuteOnly).toEqual(['web_search', 'mcp_slack_post']);
    expect(composeRun('anything', { noTools: true }).allowExecuteOnly).toEqual([]);
    expect(composeRun('New rule: when I say wind down, dim the screen', {}).allowExecuteOnly).toEqual(['define_macro']);
    expect(Object.keys(composeRun('put it on my calendar', {}).denyTools)).toContain('schedule_task');
  });
  it('has a grammar naming every category', () => {
    const g = routerGrammar();
    for (const c of ['none', 'phone', 'calendar', 'memory', 'later', 'teach', 'web', 'messages', 'music']) expect(g).toContain(`"${c}"`);
  });
});

describe('clock offsets', () => {
  const now = new Date('2026-09-05T12:30:00');
  it('reads pm off tonight and picks the sooner bare hour', () => {
    expect(clockOffsetHint('Tonight at 9, check my battery', now)).toContain('+510');
    expect(clockOffsetHint('check again at 5', now)).toContain('+270');
    expect(clockOffsetHint('at 3pm remind me', now)).toContain('+150');
    expect(clockOffsetHint('no time here', now)).toBeNull();
  });
});
