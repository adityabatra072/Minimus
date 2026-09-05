import { Ajv, type ValidateFunction } from 'ajv';
import type { JsonSchema, ToolCall } from './types.js';

/** Execution context handed to every tool executor. */
export interface ToolContext {
  /** Abort when the run is cancelled — executors doing I/O should honor it. */
  signal: AbortSignal;
}

export type ToolExecutor = (
  args: Record<string, unknown>,
  ctx: ToolContext,
) => Promise<Record<string, unknown> | string>;

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
  /**
   * Tool group for intent routing — only the groups relevant to a request are
   * exposed to small models, keeping schemas short. 'core' is always exposed.
   */
  group?: string;
  /** When true (or predicate returns true), the loop pauses for user confirmation. */
  needsApproval?: boolean | ((args: Record<string, unknown>) => boolean);
  /**
   * 'action' changes the world and its result needs no interpretation (a
   * torch is on, a timer is set); the turn after it is a confirmation and a
   * thinking model skips deliberation there. 'query' returns information the
   * model must reason about (calendar, memory, search). Default 'query'.
   */
  kind?: 'action' | 'query';
  /**
   * One-line "when to use this" rule surfaced in the system prompt. Reserve it
   * for tools small models chronically misroute (e.g. schedule_task vs
   * create_reminder) — every hint costs prompt tokens on every request.
   */
  usageHint?: string;
  execute: ToolExecutor;
}

export interface ToolValidationError {
  ok: false;
  /** One-line, model-facing description of what was wrong. */
  reason: string;
}

export interface ToolValidationOk {
  ok: true;
  tool: ToolDefinition;
}

export type ToolValidation = ToolValidationOk | ToolValidationError;

/**
 * Registry of tools available to a run. Validation errors are phrased for the
 * MODEL (they get appended to the transcript on retry), so they name the
 * available tools / expected parameters in one line.
 */
export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();
  private validators = new Map<string, ValidateFunction>();
  private ajv = new Ajv({ allErrors: false, strict: false, coerceTypes: true });

  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
    // Unknown parameters are rejected. A small model that writes
    // send_notification(to="Sam") has picked the wrong tool, and an error
    // naming the stray parameter sends it to the right one; silently
    // accepting it sends a notification to nobody.
    const schema = tool.parameters ?? { type: 'object' };
    const strict = schema.type === 'object' && schema.additionalProperties === undefined ? { ...schema, additionalProperties: false } : schema;
    this.validators.set(tool.name, this.ajv.compile(strict));
  }

  unregister(name: string): void {
    this.tools.delete(name);
    this.validators.delete(name);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /**
   * Tools for the requested groups. No group is implicit: 'core' used to ride
   * along on every request, which put the memory and macro schemas (with their
   * usage hints) into a "turn on the flashlight" prompt — 43% of that prompt,
   * re-prefilled every turn, for tools the request cannot use. Callers route
   * 'core' deliberately when a request is actually about memory or macros.
   */
  list(groups?: string[]): ToolDefinition[] {
    const all = [...this.tools.values()];
    if (!groups) return all;
    // An EMPTY list means no tools (a conversation-only run), not "all". The
    // old fallthrough put every tool in front of a message the router had
    // judged to need none, which is how "hello" got a 1500-token prompt.
    if (groups.length === 0) return [];
    const wanted = new Set(groups);
    return all.filter((t) => wanted.has(t.group ?? 'core'));
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  /** Tool names per group — the shape composeRun needs for allowlists. */
  byGroup(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const t of this.tools.values()) (out[t.group ?? 'core'] ??= []).push(t.name);
    return out;
  }

  /**
   * Validate a parsed call: tool exists + args match the schema.
   * `coerceTypes` is on because small models frequently emit "5" for 5.
   */
  validate(call: ToolCall): ToolValidation {
    const tool = this.tools.get(call.name);
    if (!tool) {
      return {
        ok: false,
        reason: `Unknown tool "${call.name}". Available tools: ${this.names().join(', ')}.`,
      };
    }
    const validator = this.validators.get(call.name);
    if (validator && !validator(call.arguments)) {
      const err = validator.errors?.[0];
      const where = err?.instancePath ? ` at "${err.instancePath}"` : '';
      const extra = (err?.params as { additionalProperty?: string } | undefined)?.additionalProperty;
      const message = extra ? `"${extra}" is not a parameter of ${call.name}` : (err?.message ?? 'schema mismatch');
      return {
        ok: false,
        reason: `Invalid arguments for "${call.name}"${where}: ${message}. Expected parameters: ${JSON.stringify(tool.parameters.properties ? Object.keys(tool.parameters.properties) : [])}.${extra ? ' If you meant a different tool, call that one.' : ''}`,
      };
    }
    return { ok: true, tool };
  }

  requiresApproval(call: ToolCall): boolean {
    const tool = this.tools.get(call.name);
    if (!tool || tool.needsApproval === undefined) return false;
    return typeof tool.needsApproval === 'function'
      ? tool.needsApproval(call.arguments)
      : tool.needsApproval;
  }
}
