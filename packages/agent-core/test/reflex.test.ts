import { describe, expect, it } from 'vitest';
import { matchReflex } from '../src/reflex.js';

const tools = new Set(['flashlight', 'set_timer', 'set_alarm', 'set_brightness', 'device_info', 'open_app', 'run_macro']);

describe('reflexes', () => {
  it('handles the plain flashlight forms', () => {
    expect(matchReflex('Turn on the flashlight', [], tools)?.call).toMatchObject({ name: 'flashlight', arguments: { on: true } });
    expect(matchReflex('torch off.', [], tools)?.call).toMatchObject({ name: 'flashlight', arguments: { on: false } });
    expect(matchReflex('please switch the torch on', [], tools)?.call.arguments).toEqual({ on: true });
  });
  it('handles timers and brightness with literal numbers only', () => {
    expect(matchReflex('set a timer for 12 minutes', [], tools)?.call.arguments).toEqual({ minutes: 12 });
    expect(matchReflex('5 min timer', [], tools)?.call.arguments).toEqual({ minutes: 5 });
    expect(matchReflex('set brightness to 80%', [], tools)?.call.arguments).toEqual({ level: 0.8 });
    expect(matchReflex('set a timer for the pasta', [], tools)).toBeNull();
  });
  it('runs a taught phrase said on its own', () => {
    expect(matchReflex('Wind down.', ['wind down'], tools)?.call).toMatchObject({ name: 'run_macro', arguments: { name: 'wind down' } });
    expect(matchReflex('wind down and set an alarm', ['wind down'], tools)).toBeNull();
  });
  it('leaves anything with a clause, a time or a person to the model', () => {
    expect(matchReflex('turn on the flashlight and set a timer', [], tools)).toBeNull();
    expect(matchReflex('turn off the flashlight in 3 minutes', [], tools)).toBeNull();
    expect(matchReflex('text Sam that I am late', [], tools)).toBeNull();
    expect(matchReflex('what is the capital of France', [], tools)).toBeNull();
  });
  it('never returns a tool that is not available', () => {
    expect(matchReflex('turn on the flashlight', [], new Set(['device_info']))).toBeNull();
  });

  it('sets alarms from the plain forms', () => {
    expect(matchReflex('wake me at 6:45', [], tools)?.call).toMatchObject({ name: 'set_alarm', arguments: { time: '06:45' } });
    expect(matchReflex('set an alarm for 7', [], tools)?.call).toMatchObject({ name: 'set_alarm', arguments: { time: '07:00' } });
    expect(matchReflex('alarm at 7:30 pm every day', [], tools)?.call).toMatchObject({ name: 'set_alarm', arguments: { time: '19:30', repeat: 'daily' } });
    expect(matchReflex('wake me up at 12 am', [], tools)?.call).toMatchObject({ name: 'set_alarm', arguments: { time: '00:00' } });
    expect(matchReflex('set an alarm for 25:00', [], tools)).toBeNull();
    expect(matchReflex('set an alarm for tomorrow if it rains', [], tools)).toBeNull();
  });
});
