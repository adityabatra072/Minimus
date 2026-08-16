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
    this.validators.set(tool.name, this.ajv.compile(tool.parameters ?? { type: 'object' }));
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
    if (!groups || groups.length === 0) return all;
    const wanted = new Set(groups);
    return all.filter((t) => wanted.has(t.group ?? 'core'));
  }

  names(): string[] {
    return [...this.tools.keys()];
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
      return {
        ok: false,
        reason: `Invalid arguments for "${call.name}"${where}: ${err?.message ?? 'schema mismatch'}. Expected parameters: ${JSON.stringify(tool.parameters.properties ? Object.keys(tool.parameters.properties) : [])}.`,
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
