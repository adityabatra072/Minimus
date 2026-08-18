import { describe, expect, it } from 'vitest';
import { AgentLoop } from '../src/loop.js';
import { ToolRegistry } from '../src/tools.js';
import { MockAdapter } from '../src/adapters/mock.js';
import type { AgentEvent, RunCheckpoint } from '../src/types.js';

function makeTools() {
  const tools = new ToolRegistry();
  const log: string[] = [];
  tools.register({
    name: 'flashlight',
    description: 'Turn the flashlight on or off',
    parameters: {
      type: 'object',
      properties: { on: { type: 'boolean', description: 'true = on' } },
      required: ['on'],
    },
    execute: async (args) => {
      log.push(`flashlight:${args['on']}`);
      return { ok: true, state: args['on'] ? 'on' : 'off' };
    },
  });
  tools.register({
    name: 'send_email',
    description: 'Send an email',
    parameters: {
      type: 'object',
      properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } },
      required: ['to', 'body'],
    },
    needsApproval: true,
    execute: async () => {
      log.push('email:sent');
      return { ok: true };
    },
  });
  return { tools, log };
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

function finished(events: AgentEvent[]) {
  const last = events.at(-1);
  if (last?.type !== 'run_finished') throw new Error('run did not finish');
  return last;
}

describe('AgentLoop', () => {
  it('runs tool call → result → final answer', async () => {
    const { tools, log } = makeTools();
    const adapter = new MockAdapter([
      "[flashlight(on=True)]",
      'Done — flashlight is on.',
    ]);
    const events = await collect(new AgentLoop().run('turn on the flashlight', { adapter, tools }));
    expect(log).toEqual(['flashlight:true']);
    expect(finished(events).reason).toBe('completed');
    expect(finished(events).finalText).toBe('Done — flashlight is on.');
    const toolEvents = events.filter((e) => e.type === 'tool_call_finished');
    expect(toolEvents).toHaveLength(1);
  });

  it('terminates immediately on plain text', async () => {
    const { tools } = makeTools();
    const adapter = new MockAdapter(['Paris is the capital of France.']);
    const events = await collect(new AgentLoop().run('capital of france?', { adapter, tools }));
    expect(finished(events).reason).toBe('completed');
    expect(events.filter((e) => e.type === 'turn_started')).toHaveLength(1);
  });

  it('demands an answer once when the final turn is empty', async () => {
    const { tools } = makeTools();
    // Turn 1: searches. Turn 2: emits nothing (instant EOS — seen on-device
    // after web_search). The loop must not end with a blank bubble — one
    // nudge, then the answer.
    const adapter = new MockAdapter([
      '[web_search(query="capital of france")]',
      '',
      'Paris.',
    ]);
    const events = await collect(new AgentLoop().run('capital of france?', { adapter, tools }));
    expect(finished(events).reason).toBe('completed');
    expect(finished(events).finalText).toBe('Paris.');
    const nudges = events.filter(
      (e) => e.type === 'parse_retry' && e.reason === 'empty final answer',
    );
    expect(nudges).toHaveLength(1);
    // The nudge must be visible to the model as a user message.
    const lastRequest = adapter.requests.at(-1)!;
    expect(lastRequest.at(-1)?.content).toContain('Continue NOW');
  });

  it('completes (not errors) when tools succeeded but the summary spiralled', async () => {
    const { tools, log } = makeTools();
    // Device case: the tool call landed, then every wrap-up turn was thinking
    // with no answer. The work happened; the run must not be reported as a
    // failure.
    const adapter = new MockAdapter([
      '[flashlight(on=True)]',
      '<think>let me reconsider</think>',
      '<think>still reconsidering</think>',
      '<think>and again</think>',
    ]);
    const events = await collect(new AgentLoop().run('flashlight on', { adapter, tools }));
    expect(log).toEqual(['flashlight:true']);
    expect(finished(events).reason).toBe('completed');
  });

  it('still errors when nothing succeeded and the model only thinks', async () => {
    const { tools } = makeTools();
    const adapter = new MockAdapter([
      '<think>hmm</think>',
      '<think>hmm again</think>',
      '<think>and again</think>',
    ]);
    const events = await collect(new AgentLoop().run('do something', { adapter, tools }));
    expect(finished(events).reason).toBe('error');
  });

  it('retries a tool call that was cut off mid-generation', async () => {
    const { tools, log } = makeTools();
    // Device evidence: output window exhausted mid-call → raw ends in an
    // unclosed call opener. Must retry, not complete with the fragment.
    const adapter = new MockAdapter([
      "[flashlight(on=",
      "[flashlight(on=True)]",
      'Flashlight is on.',
    ]);
    const events = await collect(new AgentLoop().run('flashlight on', { adapter, tools }));
    expect(finished(events).reason).toBe('completed');
    expect(finished(events).finalText).toBe('Flashlight is on.');
    expect(log).toEqual(['flashlight:true']);
    const retries = events.filter(
      (e) => e.type === 'parse_retry' && e.reason === 'truncated tool call',
    );
    expect(retries).toHaveLength(1);
  });

  it('errors out if the tool call keeps getting truncated', async () => {
    const { tools } = makeTools();
    const adapter = new MockAdapter(['[flashlight(on=', '[flashlight(on=', '[flashlight(on=']);
    const events = await collect(new AgentLoop().run('flashlight on', { adapter, tools }));
    expect(finished(events).reason).toBe('error');
  });

  it('lets the empty-turn nudge continue with a TOOL, not just text', async () => {
    const { tools, log } = makeTools();
    // Mid-task instant-EOS (seen on iPhone after tool results): the nudge
    // must not forbid tools — the model may still have work to do.
    const adapter = new MockAdapter([
      '[web_search(query="battery tips")]',
      '',
      '[flashlight(on=True)]',
      'Done.',
    ]);
    const events = await collect(new AgentLoop().run('search then flashlight', { adapter, tools }));
    expect(finished(events).reason).toBe('completed');
    expect(log).toContain('flashlight:true');
  });

  it('gives up nudging for an answer after two attempts', async () => {
    const { tools } = makeTools();
    const adapter = new MockAdapter(['', '', '']);
    const events = await collect(new AgentLoop().run('say something', { adapter, tools }));
    expect(finished(events).reason).toBe('completed');
    expect(finished(events).finalText).toBe('');
    const nudges = events.filter(
      (e) => e.type === 'parse_retry' && e.reason === 'empty final answer',
    );
    expect(nudges).toHaveLength(2);
  });

  it('retries with a nudge on unknown tool, then succeeds', async () => {
    const { tools, log } = makeTools();
    const adapter = new MockAdapter([
      '[torch(on=True)]', // unknown tool → validation error + nudge
      '[flashlight(on=True)]',
      'On now.',
    ]);
    const events = await collect(new AgentLoop().run('flashlight please', { adapter, tools }));
    expect(finished(events).reason).toBe('completed');
    expect(log).toEqual(['flashlight:true']);
    const retries = events.filter((e) => e.type === 'parse_retry');
    expect(retries).toHaveLength(1);
    // The nudge must be visible to the model on the next request.
    const lastRequest = adapter.requests.at(-1)!;
    expect(JSON.stringify(lastRequest)).toContain('Unknown tool');
  });

  it('fails the run after exhausting validation retries', async () => {
    const { tools } = makeTools();
    const adapter = new MockAdapter(['[nope(x=1)]', '[nope(x=1)]', '[nope(x=1)]', '[nope(x=1)]']);
    const events = await collect(new AgentLoop().run('do it', { adapter, tools }));
    expect(finished(events).reason).toBe('error');
  });

  it('pauses for approval and executes on approve', async () => {
    const { tools, log } = makeTools();
    const adapter = new MockAdapter([
      '<tool_call>{"name": "send_email", "arguments": {"to": "a@b.c", "body": "hi"}}</tool_call>',
      'Sent.',
    ]);
    const approvals: string[] = [];
    const events = await collect(
      new AgentLoop().run('email a@b.c saying hi', {
        adapter,
        tools,
        approvals: async (req) => {
          approvals.push(req.call.name);
          return true;
        },
      }),
    );
    expect(approvals).toEqual(['send_email']);
    expect(log).toEqual(['email:sent']);
    expect(finished(events).reason).toBe('completed');
  });

  it('records denial and lets the model continue', async () => {
    const { tools, log } = makeTools();
    const adapter = new MockAdapter([
      '<tool_call>{"name": "send_email", "arguments": {"to": "a@b.c", "body": "hi"}}</tool_call>',
      "Okay, I won't send it.",
    ]);
    const events = await collect(
      new AgentLoop().run('email someone', {
        adapter,
        tools,
        approvals: async () => false,
      }),
    );
    expect(log).toEqual([]);
    expect(finished(events).reason).toBe('completed');
    expect(finished(events).finalText).toContain("won't send");
  });

  it('checkpoints after every step and can resume', async () => {
    const { tools } = makeTools();
    const checkpoints: RunCheckpoint[] = [];
    const adapter = new MockAdapter(['[flashlight(on=True)]', 'Done.']);
    await collect(
      new AgentLoop().run('flashlight on', {
        adapter,
        tools,
        onCheckpoint: (cp) => {
          checkpoints.push(cp);
        },
      }),
    );
    expect(checkpoints.length).toBeGreaterThanOrEqual(2);

    // Resume from the first checkpoint (after tool exec, before final answer).
    const resumeAdapter = new MockAdapter(['All done (resumed).']);
    const events = await collect(
      new AgentLoop().run('', {
        adapter: resumeAdapter,
        tools,
        resumeFrom: checkpoints[0]!,
      }),
    );
    expect(finished(events).reason).toBe('completed');
    expect(finished(events).finalText).toContain('resumed');
  });

  it('caps oversized tool results', async () => {
    const tools = new ToolRegistry();
    tools.register({
      name: 'web_search',
      description: 'search',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      execute: async () => ({ results: 'x'.repeat(50_000) }),
    });
    const adapter = new MockAdapter(['[web_search(query="q")]', 'Summarized.']);
    const events = await collect(new AgentLoop().run('search q', { adapter, tools }));
    const toolFinished = events.find((e) => e.type === 'tool_call_finished');
    if (toolFinished?.type !== 'tool_call_finished') throw new Error('missing tool event');
    expect(toolFinished.result.length).toBeLessThan(7000);
    expect(toolFinished.result).toContain('[truncated');
  });

  it('breaks duplicate-call loops with a cached result instead of re-executing', async () => {
    const { tools, log } = makeTools();
    const adapter = new MockAdapter([
      '[flashlight(on=True)]',
      '[flashlight(on=True)]', // exact repeat — must NOT execute again
      'Done.',
    ]);
    const events = await collect(new AgentLoop().run('flashlight on', { adapter, tools }));
    expect(log).toEqual(['flashlight:true']); // executed exactly once
    expect(finished(events).reason).toBe('completed');
    // The duplicate notice must be visible to the model.
    expect(JSON.stringify(adapter.requests.at(-1))).toContain('DUPLICATE CALL');
  });

  it('injects a wrap-up nudge before hitting max turns', async () => {
    const { tools } = makeTools();
    const script = Array(10).fill('[flashlight(on=False)]');
    const adapter = new MockAdapter(script);
    await collect(new AgentLoop().run('loop', { adapter, tools }));
    const allRequests = JSON.stringify(adapter.requests.at(-1));
    expect(allRequests).toContain('Finish now');
  });

  it('retries when the model emits only thinking, then accepts the real answer', async () => {
    const { tools, log } = makeTools();
    const adapter = new MockAdapter([
      '<think>hmm let me consider every possibility at great length</think>',
      '[flashlight(on=True)]',
      'On.',
    ]);
    const events = await collect(new AgentLoop().run('flashlight on', { adapter, tools }));
    expect(finished(events).reason).toBe('completed');
    expect(log).toEqual(['flashlight:true']);
    expect(JSON.stringify(adapter.requests.at(-1))).toContain('ran out of space thinking');
  });

  it('stops at max turns', async () => {
    const { tools } = makeTools();
    // Model loops forever calling the same tool.
    const adapter = new MockAdapter(Array(20).fill('[flashlight(on=True)]'));
    const events = await collect(new AgentLoop().run('loop forever', { adapter, tools }));
    expect(finished(events).reason).toBe('max_turns');
  });

  it('one-tool-per-turn policy keeps only the first of parallel calls', async () => {
    const { tools, log } = makeTools();
    const adapter = new MockAdapter([
      '[flashlight(on=True), flashlight(on=False)]',
      'Done.',
    ]);
    await collect(new AgentLoop().run('toggle stuff', { adapter, tools }));
    expect(log).toEqual(['flashlight:true']);
  });
});

describe('execution allowlist', () => {
  it('refuses a tool that is visible but not runnable, and says what to do instead', async () => {
    const registry = new ToolRegistry();
    let brightnessRan = false;
    registry.register({
      name: 'set_brightness',
      group: 'device',
      description: 'set screen brightness',
      parameters: { type: 'object', properties: { level: { type: 'number' } }, required: ['level'] },
      execute: async () => {
        brightnessRan = true;
        return { ok: true };
      },
    });
    registry.register({
      name: 'define_macro',
      group: 'core',
      description: 'record a phrase',
      parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      execute: async () => ({ ok: true }),
    });

    const adapter = new MockAdapter([
      '[set_brightness(level=20)]',
      "[define_macro(name='wind down')]",
      'Recorded.',
    ]);

    const events: AgentEvent[] = [];
    for await (const ev of new AgentLoop().run('New rule: when I say wind down, dim the screen', {
      adapter,
      tools: registry,
      toolGroups: ['core', 'device'],
      allowExecuteOnly: ['define_macro'],
      approvals: async () => true,
    })) {
      events.push(ev);
    }

    expect(brightnessRan).toBe(false);
    // A refusal is NOT a tool failure: the rehearsal counts any tool error as
    // a failed beat, and a by-design refusal was turning a correct run red.
    const refused = events.find((e) => e.type === 'tool_call_refused');
    expect(refused).toBeDefined();
    expect(events.some((e) => e.type === 'tool_call_finished' && e.isError)).toBe(false);
    expect(events.some((e) => e.type === 'tool_call_finished' && e.call.name === 'define_macro')).toBe(true);
  });
});
