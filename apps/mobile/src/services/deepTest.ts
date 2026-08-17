import { RunAnywhere, AudioInputs } from '@runanywhere/core';
import { getToolRegistry } from '../tools';
import { useToolStore } from '../stores/toolStore';
import { useSessionStore } from '../stores/sessionStore';
import { useSettingsStore } from '../stores/settingsStore';
import { loadMacros, removeMacro } from '../tools/macroTools';
import { listMemories, removeMemory } from '../tools/memoryTools';
import { scheduler } from './scheduler';
import { McpClient } from './mcp';
import { ensureVoiceReady } from './voice';
import { registerVlmModel, VLM_MODEL_ID } from './catalog';
import type { CheckResult } from './selfTest';

/**
 * Deep checks: every feature the demo beats do not touch, exercised against
 * the real subsystem rather than a mock. These are slower than the fast
 * self-tests (some download models, some hit the network) and a few can only
 * report "skipped" when their prerequisite is absent — a skip is honest, a
 * silent pass would not be.
 *
 * Ordered cheapest-first so a run that gets interrupted still produced value.
 */

const ctx = () => ({ signal: new AbortController().signal });

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const tool = getToolRegistry().get(name);
  if (!tool) throw new Error(`${name} is not registered`);
  const result = await tool.execute(args, ctx());
  return typeof result === 'string' ? result : JSON.stringify(result);
}

async function checkMemoryRoundTrip(): Promise<string> {
  const marker = `qa-probe-${Date.now()}`;
  await callTool('remember', { fact: `The QA probe code is ${marker}` });
  const recalled = await callTool('recall', { query: 'QA probe code' });
  if (!recalled.includes(marker)) throw new Error(`recall did not return the fact just saved`);
  const saved = (await listMemories()).find((m) => m.text.includes(marker));
  if (saved) await removeMemory(saved.id);
  const after = (await listMemories()).some((m) => m.text.includes(marker));
  if (after) throw new Error('memory delete did not remove the fact');
  return 'remember, recall, and delete';
}

async function checkMacroRoundTrip(): Promise<string> {
  const name = `qa probe macro`;
  await callTool('define_macro', {
    name,
    steps: [{ tool: 'flashlight', arguments: { on: false } }],
  });
  const macros = await loadMacros();
  const stored = macros.find((m) => m.name.toLowerCase() === name);
  if (!stored) throw new Error('define_macro did not persist the phrase');
  if (stored.steps.length !== 1) throw new Error('macro steps were not stored');
  const ran = await callTool('run_macro', { name });
  if (/error/i.test(ran)) throw new Error(`run_macro failed: ${ran.slice(0, 80)}`);
  await removeMacro(name);
  if ((await loadMacros()).some((m) => m.name.toLowerCase() === name)) {
    throw new Error('macro delete did not remove the phrase');
  }
  return 'define, replay, and un-teach';
}

async function checkScheduledTaskRoundTrip(): Promise<string> {
  const before = await scheduler.listPending();
  await callTool('schedule_task', {
    instruction: 'QA probe task, cancelled immediately',
    when: '+90',
  });
  const after = await scheduler.listPending();
  const added = after.find((t) => !before.some((b) => b.id === t.id));
  if (!added) throw new Error('schedule_task did not create a pending task');
  await scheduler.cancel(added.id);
  if ((await scheduler.listPending()).some((t) => t.id === added.id)) {
    throw new Error('cancel did not remove the task');
  }
  return 'schedule and cancel a future agent run';
}

async function checkDeviceTools(): Promise<string> {
  const info = JSON.parse(await callTool('device_info', {})) as { battery_percent?: number };
  if (typeof info.battery_percent !== 'number') throw new Error('device_info has no battery reading');
  await callTool('set_brightness', { level: 0.5 });
  await callTool('flashlight', { on: true });
  await callTool('flashlight', { on: false });
  return `battery ${info.battery_percent}%, brightness, torch on+off`;
}

async function checkNotificationTools(): Promise<string> {
  const notifyResult = await callTool('send_notification', {
    title: 'RunAnywhere QA',
    body: 'Deep check notification',
  });
  if (/no_permission|error/i.test(notifyResult)) {
    throw new Error(`notification rejected: ${notifyResult.slice(0, 80)}`);
  }
  const timerResult = await callTool('set_timer', { minutes: 1, label: 'QA probe timer' });
  if (/error/i.test(timerResult)) throw new Error(`timer rejected: ${timerResult.slice(0, 80)}`);
  return 'notification delivered, timer scheduled';
}

async function checkCalendarWrite(): Promise<string> {
  const start = new Date(Date.now() + 26 * 60 * 60 * 1000);
  start.setMinutes(0, 0, 0);
  const iso = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}T${String(start.getHours()).padStart(2, '0')}:00:00`;
  const created = await callTool('calendar_create', {
    title: 'RunAnywhere QA probe',
    start: iso,
    duration_minutes: 15,
  });
  if (/error|no_permission/i.test(created)) {
    throw new Error(`calendar_create rejected: ${created.slice(0, 80)}`);
  }
  const day = await callTool('calendar_query', { date: iso.slice(0, 10) });
  if (!day.includes('QA probe')) throw new Error('event written but not visible in the day query');
  return 'event written and read back (delete it from the Calendar app)';
}

async function checkWebSearch(): Promise<string> {
  const raw = await callTool('web_search', { query: 'on-device language models' });
  const parsed = JSON.parse(raw) as { results?: { title: string; url: string }[] };
  const results = parsed.results ?? [];
  if (results.length === 0) throw new Error('no results (offline?)');
  if (!results[0]!.url.startsWith('http')) throw new Error('result has no usable URL');
  return `${results.length} results, first from ${new URL(results[0]!.url).hostname}`;
}

async function checkApprovalGating(): Promise<string> {
  const registry = getToolRegistry();
  const gated = ['send_email', 'send_sms', 'make_call'].filter((name) => {
    const tool = registry.get(name);
    return tool && registry.requiresApproval({ id: 'probe', name, arguments: {} });
  });
  if (gated.length === 0) throw new Error('no side-effecting tool requires approval');
  const ungated = ['flashlight', 'recall'].filter((name) =>
    registry.requiresApproval({ id: 'probe', name, arguments: {} }),
  );
  if (ungated.length > 0) throw new Error(`harmless tools ask for approval: ${ungated.join(', ')}`);
  return `${gated.join(', ')} gated; harmless tools are not`;
}

async function checkSessionPersistence(): Promise<string> {
  const store = useSessionStore.getState();
  const probeId = store.newSession();
  store.appendToActive([{ kind: 'user', text: 'qa probe message', atMs: Date.now() }]);
  // The write is fire-and-forget; give it a beat to land in storage.
  await new Promise((r) => setTimeout(r, 400));
  const transcript = await store.loadTranscript(probeId);
  if (!transcript.some((m) => m.text === 'qa probe message')) {
    throw new Error('session transcript did not persist');
  }
  useSessionStore.getState().deleteSession(probeId);
  return 'transcript written, read back, and deleted';
}

async function checkSettingsPersistence(): Promise<string> {
  const settings = useSettingsStore.getState();
  const original = settings.requireApprovals;
  settings.setRequireApprovals(!original);
  if (useSettingsStore.getState().requireApprovals === original) {
    throw new Error('settings toggle did not apply');
  }
  settings.setRequireApprovals(original);
  return 'approval toggle applies and reverts';
}

async function checkCustomHttpTool(): Promise<string> {
  const custom = useToolStore.getState().custom;
  if (custom.length === 0) return 'skipped: no custom HTTP tool configured';
  const tool = getToolRegistry().get(custom[0]!.name.toLowerCase().replace(/[^a-z0-9_]/g, '_'));
  if (!tool) throw new Error(`custom tool ${custom[0]!.name} is configured but not registered`);
  return `${custom.length} custom tool(s) registered`;
}

async function checkMcpServers(): Promise<string> {
  const servers = useToolStore.getState().mcpServers;
  if (servers.length === 0) return 'skipped: no MCP server configured';
  const reports: string[] = [];
  for (const server of servers) {
    const tools = await new McpClient(server).connect();
    if (tools.length === 0) throw new Error(`${server.name} exposed no tools`);
    reports.push(`${server.name}: ${tools.length} tools`);
  }
  return reports.join('; ');
}

async function checkVoiceRoundTrip(): Promise<string> {
  // The honest end-to-end voice test without a microphone: synthesize speech
  // with the on-device TTS, then transcribe that audio with the on-device STT
  // and check the words survive the round trip.
  await ensureVoiceReady(() => undefined);
  const phrase = 'turn on the flashlight';
  const audio = await RunAnywhere.tts.synthesize(phrase);
  if (!audio.data || audio.data.length < 1000) throw new Error('TTS produced no audio');
  const transcription = await RunAnywhere.stt.transcribe(
    AudioInputs.pcm16(audio.data, audio.sampleRate ?? 22050),
  );
  const heard = transcription.text.toLowerCase();
  const hit = ['flashlight', 'flash light', 'turn on'].some((w) => heard.includes(w));
  if (!hit) throw new Error(`STT heard "${transcription.text.slice(0, 60)}" from "${phrase}"`);
  return `spoke and heard back "${transcription.text.trim().slice(0, 40)}"`;
}

async function checkVisionModel(): Promise<string> {
  await registerVlmModel();
  const downloaded = new Set(
    (await RunAnywhere.models.list({ downloadedOnly: true }).catch(() => [])).map((m) => m.id),
  );
  if (!downloaded.has(VLM_MODEL_ID)) {
    return 'skipped: vision model not downloaded (attach a photo once to fetch it)';
  }
  await RunAnywhere.models.load(VLM_MODEL_ID);
  if (!getToolRegistry().get('describe_image')) throw new Error('describe_image not registered');
  return 'vision model present and loadable';
}

const DEEP_CHECKS: { name: string; run: () => Promise<string> }[] = [
  { name: 'Device tools', run: checkDeviceTools },
  { name: 'Memory round trip', run: checkMemoryRoundTrip },
  { name: 'Macro round trip', run: checkMacroRoundTrip },
  { name: 'Scheduled task round trip', run: checkScheduledTaskRoundTrip },
  { name: 'Approval gating', run: checkApprovalGating },
  { name: 'Session persistence', run: checkSessionPersistence },
  { name: 'Settings persistence', run: checkSettingsPersistence },
  { name: 'Notifications and timers', run: checkNotificationTools },
  { name: 'Calendar write', run: checkCalendarWrite },
  { name: 'Web search', run: checkWebSearch },
  { name: 'Custom HTTP tools', run: checkCustomHttpTool },
  { name: 'MCP servers', run: checkMcpServers },
  { name: 'Vision model', run: checkVisionModel },
  { name: 'Voice round trip (TTS to STT)', run: checkVoiceRoundTrip },
];

export async function runDeepChecks(
  onResult?: (result: CheckResult) => void,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of DEEP_CHECKS) {
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
