import { describe, expect, it } from 'vitest';
import { parseAssistantOutput, extractReasoning } from '../src/parsing.js';

const TOOLS = ['get_weather', 'set_alarm', 'web_search', 'flashlight'];

describe('hermes format', () => {
  it('parses a tagged json tool call', () => {
    const out = parseAssistantOutput(
      'Let me check.\n<tool_call>{"name": "get_weather", "arguments": {"location": "Mumbai"}}</tool_call>',
      'hermes',
      TOOLS,
    );
    expect(out.calls).toHaveLength(1);
    expect(out.calls[0]!.name).toBe('get_weather');
    expect(out.calls[0]!.arguments).toEqual({ location: 'Mumbai' });
    expect(out.text).toBe('Let me check.');
  });

  it('accepts {"tool": ...} and double-encoded arguments', () => {
    const out = parseAssistantOutput(
      '<tool_call>{"tool": "set_alarm", "arguments": "{\\"minutes\\": 10}"}</tool_call>',
      'hermes',
      TOOLS,
    );
    expect(out.calls[0]!.name).toBe('set_alarm');
    expect(out.calls[0]!.arguments).toEqual({ minutes: 10 });
  });

  it('parses bare JSON: known-name anywhere, unknown-name only as whole output', () => {
    const known = parseAssistantOutput(
      '{"name": "flashlight", "arguments": {"on": true}}',
      'hermes',
      TOOLS,
    );
    expect(known.calls).toHaveLength(1);

    // Whole output IS a call attempt → parsed even with an unknown name, so
    // the loop's validation can nudge a retry instead of "completing".
    const wholeUnknown = parseAssistantOutput('{"name": "rm_rf", "arguments": {}}', 'hermes', TOOLS);
    expect(wholeUnknown.calls).toHaveLength(1);

    // Unknown call shape embedded in prose stays prose.
    const embedded = parseAssistantOutput(
      'Config example: {"name": "rm_rf", "arguments": {}} — do not run this.',
      'hermes',
      TOOLS,
    );
    expect(embedded.calls).toHaveLength(0);
  });

  it('parses multiple tagged calls', () => {
    const out = parseAssistantOutput(
      '<tool_call>{"name": "web_search", "arguments": {"query": "a"}}</tool_call>\n' +
        '<tool_call>{"name": "web_search", "arguments": {"query": "b"}}</tool_call>',
      'hermes',
      TOOLS,
    );
    expect(out.calls).toHaveLength(2);
  });

  it('leaves plain prose untouched', () => {
    const out = parseAssistantOutput('The answer is 42.', 'hermes', TOOLS);
    expect(out.calls).toHaveLength(0);
    expect(out.text).toBe('The answer is 42.');
  });
});

describe('pythonic (LFM) format', () => {
  // iPhone 15, teach-macro: the model emitted a complete, correct call and
  // simply never wrote the closing `]`. That cost a 100-second turn and was
  // reported as "no tools", which is the worst possible outcome — the model
  // was right and the harness said it did nothing.
  it('salvages a call the model never closed', () => {
    const body =
      "define_macro(name='wind down', steps=[{'tool': 'flashlight', 'arguments': {'on': False}}])";
    const known = [...TOOLS, 'define_macro'];

    const unclosed = parseAssistantOutput(`[${body}`, 'pythonic', known);
    expect(unclosed.calls).toHaveLength(1);
    expect(unclosed.calls[0]!.name).toBe('define_macro');
    expect(unclosed.calls[0]!.arguments.name).toBe('wind down');
    expect(unclosed.text).toBe('');

    // No brackets at all is the same slip.
    const unbracketed = parseAssistantOutput(body, 'pythonic', known);
    expect(unbracketed.calls).toHaveLength(1);

    // An unknown name stays prose: salvage must not invent tools.
    const unknown = parseAssistantOutput("[rm_rf(path='/')", 'pythonic', known);
    expect(unknown.calls).toHaveLength(0);
  });

  it('parses the tagged form', () => {
    const out = parseAssistantOutput(
      '<|tool_call_start|>[get_weather(location="Mumbai")]<|tool_call_end|>',
      'pythonic',
      TOOLS,
    );
    expect(out.calls).toHaveLength(1);
    expect(out.calls[0]!.arguments).toEqual({ location: 'Mumbai' });
  });

  it('parses the BARE form when wrapper specials were swallowed (LFM2.5 quirk)', () => {
    const out = parseAssistantOutput("[get_weather(location='Mumbai')]", 'pythonic', TOOLS);
    expect(out.calls).toHaveLength(1);
    expect(out.calls[0]!.name).toBe('get_weather');
    expect(out.calls[0]!.arguments).toEqual({ location: 'Mumbai' });
    expect(out.text).toBe('');
  });

  it('parses CONCATENATED call lists `[a()][b()]` (batching-under-pressure quirk)', () => {
    // Seen on-device: asked to create several calendar events at once, the
    // model emitted back-to-back bracketed calls; the old parser returned
    // zero calls and the raw syntax rendered as the final answer.
    const out = parseAssistantOutput(
      "[set_alarm(minutes=10)][get_weather(location='Pune')][set_alarm(minutes=20)]",
      'pythonic',
      TOOLS,
    );
    expect(out.calls).toHaveLength(3);
    expect(out.calls.map((c) => c.name)).toEqual(['set_alarm', 'get_weather', 'set_alarm']);
    expect(out.calls[1]!.arguments).toEqual({ location: 'Pune' });
    expect(out.text).toBe('');
  });

  it('still parses list literals inside args when calls are concatenated', () => {
    const out = parseAssistantOutput(
      "[set_alarm(minutes=5, days=['mon', 'tue'])][get_weather(location='Goa')]",
      'pythonic',
      TOOLS,
    );
    expect(out.calls).toHaveLength(2);
    expect(out.calls[0]!.arguments).toEqual({ minutes: 5, days: ['mon', 'tue'] });
  });

  it('handles numbers, booleans, lists and single quotes', () => {
    const out = parseAssistantOutput(
      '[set_alarm(minutes=10, repeat=True, days=[\'mon\', \'tue\'], label="tea")]',
      'pythonic',
      TOOLS,
    );
    expect(out.calls[0]!.arguments).toEqual({
      minutes: 10,
      repeat: true,
      days: ['mon', 'tue'],
      label: 'tea',
    });
  });

  it('parses nested step objects with Python literals (taught-verb payload)', () => {
    // Verbatim shape LFM2.5 emits for define_macro. A naive quote swap makes
    // JSON.parse choke on `False`, which silently dropped the entire call.
    const out = parseAssistantOutput(
      "<|tool_call_start|>[define_macro(name='wind down', steps=[{'tool': 'set_brightness', " +
        "'arguments': {'level': 0.2}}, {'tool': 'flashlight', 'arguments': {'on': False}}, " +
        "{'tool': 'remember', 'arguments': {'fact': 'set my alarm'}}])]<|tool_call_end|>",
      'pythonic',
      ['define_macro'],
    );
    expect(out.calls).toHaveLength(1);
    expect(out.calls[0]!.name).toBe('define_macro');
    expect(out.calls[0]!.arguments['name']).toBe('wind down');
    const steps = out.calls[0]!.arguments['steps'] as { tool: string; arguments: Record<string, unknown> }[];
    expect(steps).toHaveLength(3);
    expect(steps[1]!.tool).toBe('flashlight');
    expect(steps[1]!.arguments['on']).toBe(false);
    expect(steps[2]!.arguments['fact']).toBe('set my alarm');
  });

  it('keeps Python keywords and quotes that appear inside string values', () => {
    const out = parseAssistantOutput(
      "[remember(fact='She said False alarm, don\\'t worry')]",
      'pythonic',
      ['remember'],
    );
    expect(out.calls).toHaveLength(1);
    expect(out.calls[0]!.arguments['fact']).toBe("She said False alarm, don't worry");
  });

  it('does NOT treat unknown bare brackets or citations as calls', () => {
    const out = parseAssistantOutput(
      'Studies [see note(1)] disagree. Also [not_a_tool(x=1)] happens.',
      'pythonic',
      TOOLS,
    );
    expect(out.calls).toHaveLength(0);
    expect(out.text).toContain('Studies');
  });

  it('parses multiple calls in one list', () => {
    const out = parseAssistantOutput(
      '[web_search(query="drake latest song"), flashlight(on=True)]',
      'pythonic',
      TOOLS,
    );
    expect(out.calls).toHaveLength(2);
    expect(out.calls[1]!.name).toBe('flashlight');
  });
});

describe('reasoning extraction', () => {
  it('extracts closed think blocks', () => {
    const { text, reasoning } = extractReasoning('<think>hmm plan</think>Answer.');
    expect(reasoning).toBe('hmm plan');
    expect(text).toBe('Answer.');
  });

  it('handles a dangling close tag (template opened the block)', () => {
    const { text, reasoning } = extractReasoning('plan text</think>[flashlight(on=True)]');
    expect(reasoning).toBe('plan text');
    expect(text).toBe('[flashlight(on=True)]');
  });

  it('passes through prose with no think tags', () => {
    const { text, reasoning } = extractReasoning('Just an answer.');
    expect(reasoning).toBe('');
    expect(text).toBe('Just an answer.');
  });
});
