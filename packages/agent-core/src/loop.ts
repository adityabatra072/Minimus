import type {
  AgentEvent,
  AssistantMessage,
  ChatMessage,
  RunCheckpoint,
  ToolCall,
} from './types.js';
import type { ModelAdapter } from './adapter.js';
import { ToolRegistry, type ToolDefinition } from './tools.js';
import { parseAssistantOutput, toToolCall } from './parsing.js';
import { buildContextBlock, buildSystemPrompt, retryNudge, splitPreamble } from './prompts.js';
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
  /**
   * Tools that may actually RUN this turn. Others stay visible to the model
   * and are refused at execution with a message saying what to do instead.
   *
   * Hiding a tool is the stronger guard and should be preferred — but it
   * costs the model the tool's NAME, and sometimes the name is the point.
   * Teaching a phrase is exactly that case: the macro's steps are written in
   * tool names, so the tools must be visible, yet running them is never right
   * (device evidence: teach-macro recorded the macro AND performed two of the
   * actions, dimming the screen and toggling the torch mid-lesson).
   */
  allowExecuteOnly?: string[];
  /** What the model is told when a call falls outside allowExecuteOnly. */
  allowExecuteReason?: string;
  /**
   * Tools that stay visible (the system prompt never changes shape, so the
   * engine can cache it) but are refused at execution this run, each with the
   * reason the model reads. This is how the deterministic guards steer a
   * small model without rewriting its prompt.
   */
  denyTools?: Record<string, string>;
  policy?: ModelPolicy;
  /** App-supplied persona/context line(s) for the system prompt. */
  preamble?: string;
  /**
   * The request needs judgment: a thinking model deliberates on every turn.
   * Otherwise (adaptive strategy) fast turns run with thinking closed and the
   * loop escalates to open thinking only when a fast turn goes wrong.
   */
  deliberate?: boolean;
  /** Clock for the context block — defaults to now; fixed in tests. */
  now?: Date;
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

/**
 * Prose a small model emits INSTEAD of a tool call: announcing the action, or
 * denying it has the tool. Checked only on a fast first turn (see loop).
 */
const NARRATION_RE =
  /\b(I(?:'ll| will| am| have|'ve|'m going to) (?:now |just )?(?:go ahead and )?(?:set|turn|check|send|open|schedul|remind|play|add|creat|start|sav|look|search|dim|increas|decreas|adjust|retriev|fetch|not|do|note))|\blet me\b|\bI (?:don't|do not|can't|cannot) (?:have|access|do|set|schedule|store|retrieve|check)\b|\bI'm unable\b|\bI am unable\b/i;

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
  const cutoff = Math.max(3, messages.length - keepRecent);
  for (let i = 2; i < cutoff; i++) {
    const m = messages[i]!;
    if (m.role === 'tool' && m.content.length > 200 && !m.content.startsWith('[elided')) {
      m.content = `[elided tool result: ${m.toolName}, ${m.content.length} chars]`;
      dropped++;
    }
  }
  if (dropped === 0) {
    for (let i = 3; i < cutoff; i++) {
      const m = messages[i]!;
      if (m.role === 'assistant' && m.content.length > 400 && !m.content.startsWith('[elided')) {
        m.content = `[elided earlier answer, ${m.content.length} chars]`;
        dropped++;
      }
    }
  }
  return dropped;
}

/**
 * `[define_macro(name='x', steps=[{...}, {'tool': 'send_not` — a call to a
 * known tool whose brackets never close. The simple regex misses it because a
 * `]` inside the arguments looks like the list's end.
 */
function unbalancedKnownCall(text: string, known: string[]): boolean {
  const m = /^\s*\[?\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\(/.exec(text);
  if (!m || !known.includes(m[1]!)) return false;
  let depth = 0;
  let quote: string | null = null;
  for (const c of text) {
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
  }
  return depth > 0 || quote !== null;
}

function capToolResult(result: string, cap: number): string {
  if (result.length <= cap) return result;
  return result.slice(0, cap) + `\n[truncated ${result.length - cap} chars]`;
}

export class AgentLoop {
  /**
   * The exact system prompt a run with these tools uses. The router pass and
   * the warm-up build theirs through this same function so the engine sees
   * one prefix all session long.
   */
  static systemPromptFor(tools: ToolDefinition[], policy: ModelPolicy, preamble?: string): string {
    return buildSystemPrompt(tools, {
      format: policy.format,
      ...(policy.toolFormat ? { toolFormat: policy.toolFormat } : {}),
      thinking: policy.thinking,
      oneToolPerTurn: policy.oneToolPerTurn,
      ...(preamble !== undefined ? { preamble: splitPreamble(preamble).persona } : {}),
    });
  }

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

    const systemPrompt = AgentLoop.systemPromptFor(exposedTools, policy, config.preamble);

    let messages: ChatMessage[];
    let startTurn: number;
    if (config.resumeFrom) {
      messages = structuredClone(config.resumeFrom.messages);
      startTurn = config.resumeFrom.turn;
    } else {
      // The clock and the per-request steering ride in a SECOND system turn
      // between the stable prompt and the user's message: the stable prompt
      // stays byte-identical across requests (the engine serves it from its
      // cache), and the model does not mistake the steering for the user's
      // words. Rig evidence for the latter: with the block inside the user
      // turn, a taught phrase got named "Current date/time: 2026-09-05…".
      const contextBlock = buildContextBlock(splitPreamble(config.preamble).context, config.now);
      messages = [
        { role: 'system', content: systemPrompt },
        { role: 'system', content: contextBlock },
        { role: 'user', content: userInput },
      ];
      startTurn = 0;
    }

    // Adaptive thinking: plain requests get a closed think block (the model
    // answers at once); the loop reopens thinking after any fast turn that
    // misfires. Deliberate requests think from the start.
    // Adaptive thinking (rig-measured): a thinking model DECIDES with the
    // block open — closing it on the first turn cost tool-choice accuracy
    // (recall→remember, send_sms→send_notification, search loops). What it
    // does not need to think about is the sentence after an action tool
    // succeeded; that turn runs closed and takes under a second.
    const adaptive = policy.thinking && (policy.thinkingStrategy === 'adaptive' || policy.thinkingStrategy === 'adaptive-fast');
    // 'adaptive-fast': the first decision also runs closed unless the request
    // was flagged as needing judgment; the router and the guards already
    // narrowed what can run. Escalation to open thinking still happens on any
    // misfire (validation failure, narration, refusal).
    const fast = policy.thinkingStrategy === 'adaptive-fast';
    // Nothing to decide when there are no tools: a conversation turn runs
    // with thinking closed and answers in a second.
    const nothingRunnable = exposedTools.length === 0 || (config.allowExecuteOnly !== undefined && config.allowExecuteOnly.length === 0);
    let thinkNext: 'open' | 'closed' = adaptive && (nothingRunnable || fast) && !config.deliberate ? 'closed' : 'open';
    let narrationNudged = false;
    /** Tools refused for the rest of the run after a runaway streak. */
    const exhausted = new Set<string>();
    /** Total calls per tool this run; alternating two tools dodges the streak. */
    const callsPerTool = new Map<string, number>();
    const MAX_CALLS_PER_TOOL = 3;
    let overruledOnce = false;

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
    let emptyAnswerNudges = 0;
    /** Side effects that actually landed — the run's real output. */
    let toolsSucceeded = 0;
    let hintsDropped = false;
    // Two chances, not one: on-device the model can emit consecutive silent
    // turns mid-task (think-then-EOS), and a single nudge left a calendar
    // booking half-done on a live demo take.
    const maxEmptyAnswerNudges = 2;

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
          ...(policy.topK !== undefined ? { topK: policy.topK } : {}),
          ...(policy.repeatPenalty !== undefined ? { repeatPenalty: policy.repeatPenalty } : {}),
          ...(policy.thinking && thinkNext === 'open' && policy.thinkingBudgetTokens !== undefined
            ? { thinkingBudgetTokens: policy.thinkingBudgetTokens }
            : {}),
          thinkingMode: policy.thinking ? thinkNext : 'none',
          maxOutputTokens: policy.maxOutputTokens,
          ...(config.signal ? { signal: config.signal } : {}),
        });
        for await (const ev of stream) {
          if (ev.type === 'delta') {
            raw += ev.text;
            yield { type: 'text_delta', text: ev.text };
          } else if (ev.type === 'done' && ev.usage) {
            yield { type: 'generation_stats', turn, usage: ev.usage };
          }
        }
        // Adapters end the stream cleanly on abort (no throw), so a cancelled
        // run reached the parser with half a turn and reported "completed".
        if (config.signal?.aborted) {
          yield { type: 'run_finished', reason: 'cancelled', finalText };
          return;
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

      // Truncated tool call: the model ran out of generation window MID-CALL
      // (device evidence: raw output ended in `[define_macro(name='`).
      // Without this check the fragment reads as a plain-text final answer
      // and the run "completes". The retry gets a fresh window, and the bare
      // call fits easily once the nudge suppresses long thinking.
      const truncatedCall =
        parsed.calls.length === 0 &&
        (policy.format === 'pythonic'
          ? /\[\s*[a-zA-Z_]\w*\s*\([^\]]*$/.test(parsed.text) || unbalancedKnownCall(parsed.text, knownToolNames)
          : /<tool_call>(?![\s\S]*<\/tool_call>)/.test(parsed.text));
      if (truncatedCall) {
        parseRetriesThisTurn++;
        thinkNext = 'open';
        if (parseRetriesThisTurn > maxParseRetries) {
          yield {
            type: 'run_finished',
            reason: 'error',
            finalText,
            error: 'tool call kept getting cut off mid-generation',
          };
          return;
        }
        messages.push({ role: 'assistant', content: parsed.text, ...(parsed.reasoning ? { reasoning: parsed.reasoning } : {}) });
        messages.push({
          role: 'user',
          content:
            'Your tool call was CUT OFF before it finished. Reply again with ONLY the complete tool call and nothing else. Do not think first.',
        });
        yield { type: 'parse_retry', attempt: parseRetriesThisTurn, reason: 'truncated tool call' };
        yield { type: 'turn_finished', turn };
        continue;
      }

      // Thinking overrun: the model burned its whole budget inside <think>
      // and emitted no visible answer. Nudge it to conclude instead of
      // treating the empty string as a completed run.
      if (parsed.calls.length === 0 && parsed.text === '' && parsed.reasoning !== '') {
        parseRetriesThisTurn++;
        if (parseRetriesThisTurn > maxParseRetries) {
          // The work is not the sentence. A run whose tools all succeeded and
          // then lost its closing summary to a spiral has still done what the
          // user asked (device evidence: device_info + remember +
          // schedule_task all correct, run reported as an error). Report it as
          // completed and let the UI name the last operation; only a run that
          // achieved nothing is an error.
          yield {
            type: 'run_finished',
            ...(toolsSucceeded > 0
              ? { reason: 'completed' as const, finalText }
              : {
                  reason: 'error' as const,
                  finalText,
                  error: 'model produced only thinking output, no answer, after retries',
                }),
          };
          return;
        }
        messages.push({ role: 'assistant', content: '', reasoning: parsed.reasoning });
        messages.push({
          role: 'user',
          content:
            'You ran out of space thinking. Decide NOW: reply with the single tool call or the short final answer. Keep thinking to one sentence.',
        });
        // An overrun means prompt + thinking exceeded the context window, so
        // asking again in the same space just repeats it (observed on device:
        // 3684 characters of thinking, then 59, then nothing). Free real room.
        // Older tool results go first; when there are none (a first-turn
        // overrun, e.g. teaching a phrase), drop the per-tool usage hints
        // instead — they are worth their tokens on attempt one, not on a
        // retry that has no room to think.
        const elided = compact(messages, 4);
        if (elided > 0) {
          yield { type: 'compaction', droppedMessages: elided };
        } else if (!hintsDropped) {
          hintsDropped = true;
          messages[0] = {
            role: 'system',
            content: buildSystemPrompt(exposedTools, {
              format: policy.format,
              ...(policy.toolFormat ? { toolFormat: policy.toolFormat } : {}),
              thinking: policy.thinking,
              oneToolPerTurn: policy.oneToolPerTurn,
              omitHints: true,
              ...(config.preamble !== undefined ? { preamble: config.preamble } : {}),
            }),
          };
        }
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

      // A fast (closed-think) first turn that DESCRIBES the action instead of
      // calling a tool, or claims it has no such tool: rig evidence on
      // LFM2.5 is "I'll check your battery level right now." followed by EOS.
      // Reopen thinking and ask for the call, once.
      if (
        adaptive &&
        thinkNext === 'closed' &&
        !narrationNudged &&
        !nothingRunnable &&
        parsed.calls.length === 0 &&
        toolsSucceeded === 0 &&
        exposedTools.length > 0 &&
        NARRATION_RE.test(parsed.text)
      ) {
        narrationNudged = true;
        thinkNext = 'open';
        messages.push({ role: 'assistant', content: parsed.text, ...(parsed.reasoning ? { reasoning: parsed.reasoning } : {}) });
        messages.push({
          role: 'user',
          content:
            'You described an action instead of performing it. If a listed tool does this, call it now with the exact syntax; otherwise answer the question directly.',
        });
        yield { type: 'parse_retry', attempt: 1, reason: 'narrated instead of acting' };
        yield { type: 'turn_finished', turn };
        continue;
      }

      // Terminal condition: plain text, no tool call.
      if (parsed.calls.length === 0) {
        // A run must never end with a blank bubble: a turn that spent itself
        // thinking (or emitted nothing) gets ONE explicit demand to answer.
        if (parsed.text.trim() === '' && emptyAnswerNudges < maxEmptyAnswerNudges) {
          emptyAnswerNudges++;
          thinkNext = 'open';
          messages.push({
            role: 'assistant',
            content: '',
            ...(parsed.reasoning ? { reasoning: parsed.reasoning } : {}),
          });
          // Neutral wording matters: on-device this fires mid-task (the
          // model emits instant-EOS turns after tool results), and a nudge
          // that forbids tools kills the rest of the job — watchdog died
          // exactly that way on the iPhone.
          messages.push({
            role: 'user',
            content:
              'You stopped without replying. Continue NOW: call the next tool the task needs, or if everything is done give the user your short answer in one or two plain sentences.',
          });
          yield { type: 'parse_retry', attempt: 1, reason: 'empty final answer' };
          yield { type: 'turn_finished', turn };
          continue;
        }
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
          thinkNext = 'open';
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

        // ---- runaway streak ----
        if (exhausted.has(call.name)) {
          const refusal = `${call.name} has been called too many times this run and is no longer available. Give the user your best answer from the results you already have.`;
          messages.push({ role: 'tool', toolCallId: call.id, toolName: call.name, content: JSON.stringify({ error: refusal }), isError: true });
          yield { type: 'tool_call_refused', call, reason: refusal };
          await checkpoint(turn + 1);
          yield { type: 'turn_finished', turn };
          continue;
        }

        // ---- per-run refusals (guards) ----
        const denial = config.denyTools?.[call.name];
        if (denial) {
          messages.push({ role: 'tool', toolCallId: call.id, toolName: call.name, content: JSON.stringify({ error: denial }), isError: true });
          yield { type: 'tool_call_refused', call, reason: denial };
          thinkNext = 'open';
          await checkpoint(turn + 1);
          yield { type: 'turn_finished', turn };
          continue;
        }

        // ---- execution allowlist ----
        // The router can be wrong. When it said "none" and the model still
        // reaches for a QUERY tool (recall, calendar_query, device_info…), the
        // model's judgment wins: reading something is harmless and answers the
        // question the router misfiled. ACTION tools stay refused — that is the
        // guard that keeps "hello" from running a macro.
        const routerOverruled =
          config.allowExecuteOnly !== undefined &&
          config.allowExecuteOnly.length === 0 &&
          validation.tool.kind !== 'action' &&
          !overruledOnce;
        if (routerOverruled) overruledOnce = true;
        if (config.allowExecuteOnly && !config.allowExecuteOnly.includes(call.name) && !routerOverruled) {
          const refusal =
            config.allowExecuteReason ??
            (config.allowExecuteOnly.length === 0
              ? 'No tools may be used for this message. Answer in plain conversation.'
              : `${call.name} cannot be run right now. Use ${config.allowExecuteOnly.join(' or ')} instead, or answer directly.`);
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            toolName: call.name,
            content: JSON.stringify({ error: refusal }),
            isError: true,
          });
          yield { type: 'tool_call_refused', call, reason: refusal };
          thinkNext = 'open';
          await checkpoint(turn + 1);
          yield { type: 'turn_finished', turn };
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
          // No tool_call_finished here: nothing executed, and painting a
          // second op on the UI rail makes the agent look like it stutters.
            yield { type: 'duplicate_call_suppressed', call };
          continue;
        }

        // ---- execute ----
        callsPerTool.set(call.name, (callsPerTool.get(call.name) ?? 0) + 1);
        if ((callsPerTool.get(call.name) ?? 0) >= MAX_CALLS_PER_TOOL) exhausted.add(call.name);
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
        if (!isError) {
          executedCalls.set(callKey, resultText);
          toolsSucceeded++;
        }
        // Next turn's thinking: closed after a successful ACTION unless the
        // request needs judgment throughout; open after anything the model
        // has to interpret.
        if (adaptive) {
          thinkNext = !isError && validation.tool.kind === 'action' && !config.deliberate ? 'closed' : 'open';
        }
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
      // Rig evidence: a search that returns nothing useful gets called five
      // times in a row despite the nudge. Three is the limit; after that the
      // tool is refused for the rest of the run and the model must conclude.
      if (streakCount >= 3) exhausted.add(streakTool);

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
