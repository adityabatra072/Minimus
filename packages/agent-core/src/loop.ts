import type {
  AgentEvent,
  AssistantMessage,
  ChatMessage,
  RunCheckpoint,
  ToolCall,
} from './types.js';
import type { ModelAdapter } from './adapter.js';
import { ToolRegistry } from './tools.js';
import { parseAssistantOutput, toToolCall } from './parsing.js';
import { buildSystemPrompt, retryNudge } from './prompts.js';
import { policyFor, type ModelPolicy } from './policy.js';

/**
 * The agent harness: a single linear while-loop over (model → parse → validate
 * → approve → execute → append), in the mini-swe-agent / tiny-agents mold.
 * All state lives in the append-only `messages` array; a checkpoint after every
 * step makes runs resumable after the OS kills the app.
 */

export interface ApprovalRequest {
  call: ToolCall;
}

export type ApprovalHandler = (req: ApprovalRequest) => Promise<boolean>;

export interface AgentRunConfig {
  adapter: ModelAdapter;
  tools: ToolRegistry;
  /** Tool groups to expose ('core' is always included). */
  toolGroups?: string[];
  /**
   * Tools to hide from the model this run even when their group is exposed.
   * A tool the model cannot see is a tool it cannot misuse — deterministic
   * intent routing (e.g. "in 3 minutes" hides set_timer so the deferred work
   * goes to schedule_task) beats prompt persuasion on small models.
   */
  excludeTools?: string[];
  policy?: ModelPolicy;
  /** App-supplied persona/context line(s) for the system prompt. */
  preamble?: string;
  approvals?: ApprovalHandler;
  onCheckpoint?: (cp: RunCheckpoint) => void | Promise<void>;
  signal?: AbortSignal;
  /** Parse-failure retries per turn (each retry appends a corrective nudge). */
  maxParseRetries?: number;
  runId?: string;
  /** Resume from a checkpoint instead of starting fresh. */
  resumeFrom?: RunCheckpoint;
}

const APPROX_CHARS_PER_TOKEN = 4;

function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += m.content.length + 20;
    if (m.role === 'assistant') {
      for (const c of m.toolCalls ?? []) chars += JSON.stringify(c.arguments).length + c.name.length + 20;
      chars += m.reasoning?.length ?? 0;
    }
  }
  return Math.ceil(chars / APPROX_CHARS_PER_TOKEN);
}

/**
 * Deterministic compaction: elide the OLDEST tool results first, then the
 * oldest assistant prose, never touching the system prompt, the first user
 * message (the task), or the most recent `keepRecent` messages.
 */
function compact(messages: ChatMessage[], keepRecent = 6): number {
  let dropped = 0;
  const cutoff = Math.max(2, messages.length - keepRecent);
  for (let i = 1; i < cutoff; i++) {
    const m = messages[i]!;
    if (m.role === 'tool' && m.content.length > 200 && !m.content.startsWith('[elided')) {
      m.content = `[elided tool result: ${m.toolName}, ${m.content.length} chars]`;
      dropped++;
    }
  }
  if (dropped === 0) {
    for (let i = 2; i < cutoff; i++) {
      const m = messages[i]!;
      if (m.role === 'assistant' && m.content.length > 400 && !m.content.startsWith('[elided')) {
        m.content = `[elided earlier answer, ${m.content.length} chars]`;
        dropped++;
      }
    }
  }
  return dropped;
}

function capToolResult(result: string, cap: number): string {
  if (result.length <= cap) return result;
  return result.slice(0, cap) + `\n[truncated ${result.length - cap} chars]`;
}

export class AgentLoop {
  /**
   * Run one agent task. Yields UI-renderable events; the final event is always
   * `run_finished`. The transcript (for persistence/resume) is available on the
   * checkpoint callback after every step.
   */
  async *run(userInput: string, config: AgentRunConfig): AsyncGenerator<AgentEvent> {
    const policy = config.policy ?? policyFor(config.adapter.modelId);
    const runId = config.runId ?? `run_${Date.now().toString(36)}`;
    const maxParseRetries = config.maxParseRetries ?? 2;
    const excluded = new Set(config.excludeTools ?? []);
    const exposedTools = config.tools
      .list(config.toolGroups)
      .filter((t) => !excluded.has(t.name));
    const knownToolNames = exposedTools.map((t) => t.name);

    const systemPrompt = buildSystemPrompt(exposedTools, {
      format: policy.format,
      oneToolPerTurn: policy.oneToolPerTurn,
      ...(config.preamble !== undefined ? { preamble: config.preamble } : {}),
    });

    let messages: ChatMessage[];
    let startTurn: number;
    if (config.resumeFrom) {
      messages = structuredClone(config.resumeFrom.messages);
      startTurn = config.resumeFrom.turn;
    } else {
      messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userInput },
      ];
      startTurn = 0;
    }

    yield { type: 'run_started', runId };

    const checkpoint = async (turn: number) => {
      await config.onCheckpoint?.({ runId, turn, messages: structuredClone(messages), createdAtMs: Date.now() });
    };

    let finalText = '';
    let parseRetriesThisTurn = 0;
    // Duplicate-call breaker: small models love re-running the same search
    // "to be sure". Cache results by tool+args; a repeat gets the cached value
    // plus an explicit instruction to conclude, and costs no real execution.
    const executedCalls = new Map<string, string>();
    let wrapUpNudged = false;
    // Same-tool streak: 3+ consecutive calls to one tool (with varied args —
    // the duplicate breaker can't catch those) means the model is refining
    // instead of concluding.
    let streakTool = '';
    let streakCount = 0;
    let streakNudged = false;

    for (let turn = startTurn; turn < policy.maxTurns; turn++) {
      if (config.signal?.aborted) {
        yield { type: 'run_finished', reason: 'cancelled', finalText };
        return;
      }
      yield { type: 'turn_started', turn };

      // ---- generate ----
      let raw = '';
      try {
        const stream = config.adapter.generate(messages, {
          temperature: policy.temperature,
          topP: policy.topP,
          maxOutputTokens: policy.maxOutputTokens,
          ...(config.signal ? { signal: config.signal } : {}),
        });
        for await (const ev of stream) {
          if (ev.type === 'delta') {
            raw += ev.text;
            yield { type: 'text_delta', text: ev.text };
          }
        }
      } catch (err) {
        if (config.signal?.aborted) {
          yield { type: 'run_finished', reason: 'cancelled', finalText };
          return;
        }
        yield {
          type: 'run_finished',
          reason: 'error',
          finalText,
          error: err instanceof Error ? err.message : String(err),
        };
        return;
      }

      // ---- parse ----
      const parsed = parseAssistantOutput(raw, policy.format, knownToolNames);
      if (parsed.reasoning) yield { type: 'reasoning_delta', text: parsed.reasoning };

      // Thinking overrun: the model burned its whole budget inside <think>
      // and emitted no visible answer. Nudge it to conclude instead of
      // treating the empty string as a completed run.
      if (parsed.calls.length === 0 && parsed.text === '' && parsed.reasoning !== '') {
        parseRetriesThisTurn++;
        if (parseRetriesThisTurn > maxParseRetries) {
          yield {
            type: 'run_finished',
            reason: 'error',
            finalText,
            error: 'model produced only thinking output, no answer, after retries',
          };
          return;
        }
        messages.push({ role: 'assistant', content: '', reasoning: parsed.reasoning });
        messages.push({
          role: 'user',
          content:
            'You ran out of space thinking. Decide NOW: reply with the single tool call or the short final answer. Keep thinking to one sentence.',
        });
        yield { type: 'parse_retry', attempt: parseRetriesThisTurn, reason: 'thinking overrun' };
        yield { type: 'turn_finished', turn };
        continue;
      }

      yield {
        type: 'assistant_turn',
        turn,
        text: parsed.text,
        reasoning: parsed.reasoning,
        toolCallCount: parsed.calls.length,
      };

      // Terminal condition: plain text, no tool call.
      if (parsed.calls.length === 0) {
        const assistant: AssistantMessage = {
          role: 'assistant',
          content: parsed.text,
          ...(parsed.reasoning ? { reasoning: parsed.reasoning } : {}),
        };
        messages.push(assistant);
        finalText = parsed.text;
        await checkpoint(turn + 1);
        yield { type: 'turn_finished', turn };
        yield { type: 'run_finished', reason: 'completed', finalText };
        return;
      }

      // Enforce one-tool-per-turn for small models: keep the FIRST call only.
      const callsToRun = policy.oneToolPerTurn ? parsed.calls.slice(0, 1) : parsed.calls;
      const toolCalls = callsToRun.map(toToolCall);

      const assistant: AssistantMessage = {
        role: 'assistant',
        content: parsed.text,
        ...(parsed.reasoning ? { reasoning: parsed.reasoning } : {}),
        toolCalls,
      };
      messages.push(assistant);

      for (const call of toolCalls) {
        yield { type: 'tool_call_proposed', call };

        // ---- validate ----
        const validation = config.tools.validate(call);
        if (!validation.ok) {
          parseRetriesThisTurn++;
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            toolName: call.name,
            content: JSON.stringify({ error: validation.reason }),
            isError: true,
          });
          if (parseRetriesThisTurn > maxParseRetries) {
            await checkpoint(turn + 1);
            yield {
              type: 'run_finished',
              reason: 'error',
              finalText,
              error: `tool call failed validation ${parseRetriesThisTurn} times: ${validation.reason}`,
            };
            return;
          }
          messages.push({ role: 'user', content: retryNudge(validation.reason, policy.format) });
          yield { type: 'parse_retry', attempt: parseRetriesThisTurn, reason: validation.reason };
          continue;
        }

        // ---- approve ----
        if (config.tools.requiresApproval(call)) {
          yield { type: 'approval_required', call };
          const approved = config.approvals ? await config.approvals({ call }) : false;
          yield { type: 'approval_resolved', call, approved };
          if (!approved) {
            messages.push({
              role: 'tool',
              toolCallId: call.id,
              toolName: call.name,
              content: JSON.stringify({ error: 'The user declined this action.' }),
              isError: true,
            });
            await checkpoint(turn + 1);
            // Let the model acknowledge the denial in its next turn rather than
            // hard-stopping the run — it may have a fallback.
            continue;
          }
        }

        // ---- duplicate breaker ----
        const callKey = `${call.name}:${JSON.stringify(call.arguments)}`;
        const cached = executedCalls.get(callKey);
        if (cached !== undefined) {
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            toolName: call.name,
            content: JSON.stringify({
              note: 'DUPLICATE CALL — you already ran this exact call; its result is repeated below. Do not call it again. Answer the user now, or call a DIFFERENT tool.',
              result: cached.slice(0, 1000),
            }),
          });
          yield { type: 'tool_call_finished', call, result: cached, isError: false };
          continue;
        }

        // ---- execute ----
        yield { type: 'tool_call_started', call };
        const controller = new AbortController();
        const onAbort = () => controller.abort();
        config.signal?.addEventListener('abort', onAbort, { once: true });
        let resultText: string;
        let isError = false;
        try {
          const result = await validation.tool.execute(call.arguments, { signal: controller.signal });
          resultText = typeof result === 'string' ? result : JSON.stringify(result);
        } catch (err) {
          isError = true;
          resultText = JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          });
        } finally {
          config.signal?.removeEventListener('abort', onAbort);
        }
        resultText = capToolResult(resultText, policy.toolResultCharCap);
        if (!isError) executedCalls.set(callKey, resultText);
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          toolName: call.name,
          content: resultText,
          isError,
        });
        yield { type: 'tool_call_finished', call, result: resultText, isError };
      }

      // ---- same-tool streak nudge ----
      const lastCallName = toolCalls[toolCalls.length - 1]?.name ?? '';
      if (lastCallName === streakTool) {
        streakCount++;
      } else {
        streakTool = lastCallName;
        streakCount = 1;
        streakNudged = false;
      }
      if (streakCount >= 2 && !streakNudged) {
        streakNudged = true;
        messages.push({
          role: 'user',
          content: `You have called ${streakTool} ${streakCount} times. The results above are sufficient — do not call it again. Answer the user now.`,
        });
      }

      // ---- wrap-up nudge ----
      // Two turns before the cap, tell the model to conclude with what it has;
      // beats silently dying at max_turns with no answer at all.
      if (!wrapUpNudged && turn === policy.maxTurns - 3) {
        wrapUpNudged = true;
        messages.push({
          role: 'user',
          content:
            'Finish now: based on the tool results above, give your final answer. Do not call any more tools.',
        });
      }

      // ---- compact ----
      const estimated = estimateTokens(messages);
      if (estimated > policy.contextWindowTokens * 0.75) {
        const dropped = compact(messages);
        if (dropped > 0) yield { type: 'compaction', droppedMessages: dropped };
      }

      await checkpoint(turn + 1);
      yield { type: 'turn_finished', turn };
    }

    yield {
      type: 'run_finished',
      reason: 'max_turns',
      finalText,
      error: `stopped after ${policy.maxTurns} turns without a final answer`,
    };
  }
}
