import type { ToolCall } from '@minimus/agent-core';

/**
 * Human phrasing for the action rail. The model's tool syntax NEVER reaches
 * the screen — every operation gets a present-progressive verb line while
 * running and a plain-past result line when done.
 */

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' && v.trim() ? v.trim() : fallback;
}

export function verbFor(call: ToolCall): string {
  const a = call.arguments;
  switch (call.name) {
    case 'flashlight':
      return a['on'] ? 'Turning flashlight on' : 'Turning flashlight off';
    case 'set_brightness':
      return `Setting brightness to ${Math.round(Number(a['level']) * 100)}%`;
    case 'device_info':
      return 'Reading device status';
    case 'open_app':
      return `Opening ${str(a['app'], 'app')}`;
    case 'clipboard_write':
      return 'Copying to clipboard';
    case 'web_search':
      return `Searching “${str(a['query'], '…')}”`;
    case 'fetch_page':
      return 'Reading page';
    case 'calendar_create':
      return `Adding “${str(a['title'], 'event')}” to calendar`;
    case 'calendar_query':
      return 'Checking calendar';
    case 'create_reminder':
      return `Setting reminder “${str(a['title'], '…')}”`;
    case 'set_alarm':
      return `Setting alarm for ${str(a['time'], '…')}`;
    case 'set_timer': {
      const m = Number(a['minutes']);
      return `Starting a ${Number.isFinite(m) ? m : '…'} min timer`;
    }
    case 'schedule_task':
      return `Scheduling: ${str(a['instruction'], 'task')}`;
    case 'send_notification':
      return 'Posting notification';
    case 'play_music':
      return `Playing ${str(a['query'], 'music')}`;
    case 'send_email':
      return `Drafting email to ${str(a['to'], '…')}`;
    case 'send_sms':
      return `Drafting message to ${str(a['to'], '…')}`;
    case 'make_call':
      return `Calling ${str(a['to'], '…')}`;
    case 'run_js':
      return 'Running code';
    default:
      return call.name.replace(/_/g, ' ');
  }
}

export function resultFor(call: ToolCall, resultJson: string, isError: boolean): string {
  if (isError) {
    try {
      const parsed = JSON.parse(resultJson) as { error?: string };
      return parsed.error ?? 'Failed';
    } catch {
      return 'Failed';
    }
  }
  let r: Record<string, unknown> = {};
  try {
    r = JSON.parse(resultJson) as Record<string, unknown>;
  } catch {
    /* non-JSON results fall through to the generic line */
  }
  switch (call.name) {
    case 'flashlight':
      return r['state'] === 'on' ? 'Flashlight on' : 'Flashlight off';
    case 'set_brightness':
      return 'Brightness set';
    case 'device_info': {
      const b = r['battery_percent'];
      return typeof b === 'number' ? `Battery ${b}%${r['charging'] ? ', charging' : ''}` : 'Done';
    }
    case 'open_app':
      return `Opened ${str(r['opened'], 'app')}`;
    case 'web_search': {
      const results = Array.isArray(r['results']) ? r['results'].length : 0;
      return `${results} result${results === 1 ? '' : 's'}`;
    }
    case 'fetch_page':
      return 'Page read';
    case 'calendar_create':
      return r['status'] === 'editor_opened_for_confirmation' ? 'Opened in calendar' : 'Event added';
    case 'set_alarm':
      return 'Alarm set';
    case 'set_timer':
      return 'Timer running';
    case 'schedule_task':
      return 'Scheduled';
    case 'send_notification':
      return 'Notified';
    case 'clipboard_write':
      return 'Copied';
    case 'play_music':
      return 'Playing';
    case 'send_email':
    case 'send_sms':
      return 'Ready to send';
    case 'make_call':
      return 'Dialing';
    case 'run_js':
      return 'Done';
    default:
      return 'Done';
  }
}
