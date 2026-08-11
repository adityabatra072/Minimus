import type { ChatMessage } from '../types.js';
import type { AdapterEvent, GenerateOptions, ModelAdapter } from '../adapter.js';

/**
 * Scripted adapter for unit tests: yields each queued output once, in order.
 * A script entry can also be a function of the transcript, for tests that
 * assert on what the loop actually sent (e.g. retry nudges).
 */
export type MockScriptEntry = string | ((messages: ChatMessage[]) => string);

export class MockAdapter implements ModelAdapter {
  readonly modelId: string;
  readonly requests: ChatMessage[][] = [];
  private script: MockScriptEntry[];

  constructor(script: MockScriptEntry[], modelId = 'mock-lfm-test') {
    this.script = [...script];
    this.modelId = modelId;
  }

  async *generate(messages: ChatMessage[], _options: GenerateOptions): AsyncIterable<AdapterEvent> {
    this.requests.push(structuredClone(messages));
    const entry = this.script.shift();
    if (entry === undefined) {
      throw new Error('MockAdapter script exhausted');
    }
    const output = typeof entry === 'function' ? entry(messages) : entry;
    // Emit in two chunks to exercise streaming assembly.
    const mid = Math.floor(output.length / 2);
    if (mid > 0) yield { type: 'delta', text: output.slice(0, mid) };
    yield { type: 'delta', text: output.slice(mid) };
    yield { type: 'done' };
  }
}
