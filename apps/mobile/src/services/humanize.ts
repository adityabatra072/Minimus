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
    case 'clipboard_read':
      return 'Reading clipboard';
    case 'open_url':
      return `Opening ${str(a['url'], 'link').replace(/^https?:\/\//, '').slice(0, 40)}`;
    case 'find_contact':
      return `Looking up ${str(a['name'], 'contact')}`;
    case 'describe_image':
      return 'Looking at the photo';
    case 'define_macro':
      return `Learning “${str(a['name'], 'phrase')}”`;
    case 'run_macro':
      return `Running “${str(a['name'], 'phrase')}”`;
    case 'schedule_task':
      return `Scheduling: ${str(a['instruction'], 'task').slice(0, 60)}`;
    case 'web_search':
      return `Searching “${str(a['query'], '…')}”`;
    case 'fetch_page':
      return 'Reading page';
    case 'calendar_create':
      return `Adding “${str(a['title'], 'event')}” to calendar`;
    case 'calendar_query':
      return `Checking calendar for ${str(a['date'], 'today')}`;
    case 'create_reminder':
      return `Adding reminder “${str(a['title'], '…')}”`;
    case 'set_alarm':
      return `Setting alarm for ${str(a['time'], '…')}${a['repeat'] === 'daily' ? ' every day' : ''}`;
    case 'daily_brief':
      return 'Gathering your day';
    case 'set_timer': {
      const m = Number(a['minutes']);
      return `Starting a ${Number.isFinite(m) ? m : '…'} min timer`;
    }
    case 'list_alarms':
      return 'Checking alarms and timers';
    case 'cancel_alarm':
      return a['all'] === true ? 'Cancelling every alarm' : `Cancelling the ${str(a['time'], str(a['label'], ''))} alarm`.replace('the  alarm', 'alarm');
    case 'change_alarm':
      return a['new_time'] ? `Moving the alarm to ${str(a['new_time'])}` : 'Changing the alarm';
    case 'timer_control': {
      const act = str(a['action'], '');
      return act === 'add_minutes' ? `Adding ${typeof a['minutes'] === 'number' ? a['minutes'] : str(a['minutes'], '…')} min to the timer` : act === 'cancel' ? 'Cancelling the timer' : act === 'pause' ? 'Pausing the timer' : 'Resuming the timer';
    }
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
    case 'remember':
      return 'Saving to memory';
    case 'delete_macro':
      return `Forgetting the phrase “${str(a['name'], '…')}”`;
    case 'forget':
      return a['all'] === true ? 'Forgetting everything' : `Forgetting ${str(a['about'], '…')}`;
    case 'recall':
      return `Searching memory for “${str(a['query'], '…')}”`;
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
    case 'calendar_query': {
      const events = Array.isArray(r['events']) ? r['events'].length : 0;
      const gaps = Array.isArray(r['free_gaps']) ? r['free_gaps'].length : 0;
      return `${events} event${events === 1 ? '' : 's'}, ${gaps} free gap${gaps === 1 ? '' : 's'}`;
    }
    case 'set_alarm':
      return r['alarm_set_for'] ? `Alarm set for ${str(r['alarm_set_for'])}${r['repeats'] === 'daily' ? ', daily' : ''}` : 'Alarm set';
    case 'list_alarms': {
      const al = Array.isArray(r['alarms']) ? r['alarms'].length : 0;
      const tm = Array.isArray(r['timers']) ? r['timers'].length : 0;
      return `${al} alarm${al === 1 ? '' : 's'}, ${tm} timer${tm === 1 ? '' : 's'}`;
    }
    case 'cancel_alarm': {
      const removed = Array.isArray(r['removed']) ? r['removed'] : [];
      return removed.length === 0 ? 'Nothing to cancel' : r['disabled_only'] ? `Switched off ${removed.join(', ')}` : `Cancelled ${removed.join(', ')}`;
    }
    case 'change_alarm':
      return r['ok'] === true ? `Alarm ${str(r['was'])} → ${str(r['now'])}${r['enabled'] === false ? ' (off)' : ''}` : str(r['note'], 'No change');
    case 'timer_control': {
      const timers = Array.isArray(r['timers']) ? r['timers'] : [];
      return r['ok'] === true ? timers.join('; ') : str(r['note'], 'No timer');
    }
    case 'set_timer':
      return r['ends_in'] ? `Timer running · ${str(r['ends_in'])}` : 'Timer running';
    case 'daily_brief': {
      const ev = Array.isArray(r['calendar_today']) ? r['calendar_today'].length : 0;
      const rem = Array.isArray(r['reminders_due']) ? r['reminders_due'].length : 0;
      return `${ev} event${ev === 1 ? '' : 's'}, ${rem} reminder${rem === 1 ? '' : 's'}`;
    }
    case 'schedule_task':
      return 'Scheduled';
    case 'send_notification':
      return 'Notified';
    case 'clipboard_write':
      return 'Copied';
    case 'clipboard_read':
      return r['empty'] ? 'Clipboard is empty' : `Read ${String(r['text'] ?? '').length} characters`;
    case 'open_url':
      return 'Opened';
    case 'find_contact': {
      const matches = Array.isArray(r['matches']) ? r['matches'].length : 0;
      return matches > 0 ? `${matches} match${matches === 1 ? '' : 'es'}` : 'No match';
    }
    case 'create_reminder':
      return r['due'] ? `Reminder set for ${String(r['due'])}` : 'Added to Reminders';
    case 'describe_image':
      return 'Described';
    case 'define_macro':
      return `Learned, ${String(r['step_count'] ?? '?')} steps`;
    case 'run_macro': {
      const performed = Array.isArray(r['performed']) ? (r['performed'] as { ok: boolean }[]) : [];
      const okCount = performed.filter((s) => s.ok).length;
      return `${okCount}/${performed.length} steps done`;
    }
    case 'play_music':
      return r['now_playing'] ? `Playing ${str(r['now_playing'])}` : 'Opened in Spotify';
    case 'remember':
      return 'Saved on this phone';
    case 'delete_macro':
      return r['ok'] === true ? `Phrase “${str(r['forgot_phrase'])}” forgotten` : 'No such phrase';
    case 'forget': {
      const forgot = Array.isArray(r['forgot']) ? r['forgot'] : [];
      return forgot.length === 0 ? 'Nothing matched' : forgot.length === 1 ? `Forgot “${String(forgot[0]).slice(0, 60)}”` : `Forgot ${forgot.length} facts`;
    }
    case 'recall': {
      const matches = Array.isArray(r['matches']) ? r['matches'].length : 0;
      return matches > 0 ? `${matches} memory match${matches === 1 ? '' : 'es'}` : 'Nothing saved yet';
    }
    case 'send_email':
    case 'send_sms':
      return r['to'] ? `Ready to send to ${String(r['to'])}` : 'Ready to send';
    case 'make_call':
      return 'Dialing';
    case 'run_js':
      return 'Done';
    default:
      return 'Done';
  }
}
