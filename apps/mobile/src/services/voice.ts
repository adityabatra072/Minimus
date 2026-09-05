import { NativeEventEmitter, NativeModules } from 'react-native';
import RNFS from 'react-native-fs';
import { engine } from './engine';
import { renderChatMl } from '@minimus/agent-core';
import { useSettingsStore } from '../stores/settingsStore';
import { diag } from './diag';

/**
 * Voice, rebuilt on what the phone already has.
 *
 * Hearing: Apple's on-device recognizer (SFSpeechRecognizer). It is better
 * than any small model we could download, it is offline, it streams partial
 * words while you speak, and it takes a list of words to favour — taught
 * phrases, "new rule", tool vocabulary — so the app's own language is heard
 * right. A short LLM pass then repairs what is left: given the transcript and
 * the app's vocabulary, it returns the sentence the user most likely said.
 *
 * Speaking: the system synthesizer with the best English voice installed
 * (Siri-class voices when the user has downloaded them), or an
 * OpenAI-compatible cloud TTS endpoint when configured.
 */

export type VoiceState = 'idle' | 'preparing' | 'listening' | 'transcribing' | 'speaking';

interface SpeechNative {
  speechAuthorization(): Promise<{ speech: string; microphone: boolean; onDevice: boolean; available: boolean }>;
  speechStart(contextualStrings: string[], onDevice: boolean, recordPath: string): Promise<void>;
  speechStop(): Promise<string>;
  speechCancel(): Promise<void>;
}
interface AlarmsNative {
  speakSystem(text: string, rate: number, voiceId: string): Promise<void>;
  stopSystemSpeech(): Promise<void>;
  systemVoices(): Promise<{ id: string; name: string; language: string; quality: string }[]>;
  playAudioFile(path: string): Promise<void>;
  stopAudio(): Promise<void>;
}

const speech = (NativeModules as Record<string, SpeechNative | undefined>)['MinimusSpeech'];
const alarms = (NativeModules as Record<string, AlarmsNative | undefined>)['MinimusAlarms'];

export function voiceAvailable(): boolean {
  return !!speech && !!alarms;
}

/** Words the recognizer should favour: the app's own vocabulary plus taught phrases. */
export function voiceVocabulary(macroNames: string[]): string[] {
  return [
    'Minimus',
    'new rule',
    'when I say',
    'remember that',
    'remind me',
    'flashlight',
    'torch',
    'brightness',
    'battery',
    'calendar',
    'timer',
    'alarm',
    'Spotify',
    'wind down',
    'focus mode',
    'schedule',
    'tomorrow',
    'tonight',
    ...macroNames,
  ];
}

const WAKE_RE = /^\s*(hey |ok |okay )?(mini\s?mus|minimus|minimis|minimous|minimum)[,.!?\s]+/i;

export async function ensureVoiceReady(onProgress: (label: string) => void): Promise<void> {
  if (!speech || !alarms) throw new Error('Voice is not available in this build.');
  onProgress('preparing voice…');
  const auth = await speech.speechAuthorization();
  if (auth.speech !== 'authorized') throw new Error('Speech recognition permission denied — enable it in Settings.');
  if (!auth.microphone) throw new Error('Microphone permission denied — enable it in Settings.');
  if (!auth.available) throw new Error('Speech recognition is not available right now.');
  onProgress('');
}

/**
 * Repair a transcript with the language model: misheard app vocabulary,
 * dropped words, homophones. Runs on the router lane (its own cache), closed
 * thinking, a few dozen tokens. Returns the original on any doubt.
 */
export async function correctTranscript(raw: string, macroNames: string[]): Promise<string> {
  const text = raw.trim();
  if (!text || !engine.isReady() || !useSettingsStore.getState().voice.llmCorrection) return text;
  const vocab = voiceVocabulary(macroNames).slice(0, 30).join(', ');
  const prompt = renderChatMl(
    [
      {
        role: 'system',
        content:
          'You fix speech-recognition transcripts for a phone assistant. Given a transcript, return the sentence the user most likely said, correcting misheard words toward the app vocabulary when that is clearly what was meant. Keep the meaning and length; never add or remove requests. Reply with the corrected sentence only.\n' +
          `App vocabulary: ${vocab}.`,
      },
      { role: 'user', content: text },
    ],
    { lfm: true, thinking: 'closed' },
  );
  try {
    const r = await engine.classify(prompt, '', Math.min(80, Math.ceil(text.length / 2) + 16));
    const fixed = r.text.replace(/<think>[\s\S]*?<\/think>/g, '').trim().replace(/^["“]|["”]$/g, '');
    // A rewrite that doubles in length or shrinks to nothing is the model
    // talking, not correcting.
    if (!fixed || fixed.length > text.length * 1.8 || fixed.length < text.length * 0.4) return text;
    if (fixed !== text) diag(`voice corrected: ${JSON.stringify(text)} → ${JSON.stringify(fixed)}`);
    return fixed;
  } catch {
    return text;
  }
}

export interface VoiceCallbacks {
  onState: (state: VoiceState, detail?: string) => void;
  /** Live words while listening (partial transcript). */
  onPartial?: (text: string) => void;
  /** Final transcript of one utterance (wake phrase already stripped). */
  onUtterance: (text: string) => void;
}

export class VoicePipeline {
  private active = false;
  private requireWake = false;
  private pushToTalk = false;
  private lastPartial = '';
  private partialAt = 0;
  private emitter = new NativeEventEmitter(NativeModules['MinimusSpeech']);
  private subs: { remove: () => void }[] = [];
  private silenceTimer: ReturnType<typeof setInterval> | null = null;
  private macroNames: string[] = [];
  private recordPath = '';

  constructor(private callbacks: VoiceCallbacks) {}

  setRequireWake(on: boolean): void {
    this.requireWake = on;
  }

  setMacroNames(names: string[]): void {
    this.macroNames = names;
  }

  get listening(): boolean {
    return this.active;
  }

  async start(options: { pushToTalk?: boolean } = {}): Promise<void> {
    if (!speech) throw new Error('Voice is not available in this build.');
    if (this.active) return;
    this.pushToTalk = options.pushToTalk ?? false;
    this.lastPartial = '';
    this.partialAt = Date.now();
    this.active = true;
    this.subs.forEach((s) => s.remove());
    this.subs = [
      this.emitter.addListener('MinimusSpeech', (ev: { text: string; isFinal: boolean }) => {
        if (!this.active) return;
        if (ev.text !== this.lastPartial) {
          this.lastPartial = ev.text;
          this.partialAt = Date.now();
          this.callbacks.onPartial?.(ev.text);
        }
      }),
    ];
    const remote = useSettingsStore.getState().voice.remoteStt;
    this.recordPath = remote.enabled ? `${RNFS.CachesDirectoryPath}/utterance.wav` : '';
    this.callbacks.onState('listening');
    await speech.speechStart(voiceVocabulary(this.macroNames), true, this.recordPath);
    if (!this.pushToTalk) {
      // Hands-free endpointing: the utterance is over when the transcript has
      // not changed for a moment after saying something.
      this.silenceTimer = setInterval(() => {
        const quiet = Date.now() - this.partialAt;
        if (this.lastPartial && quiet > 1400) void this.closeUtterance();
        else if (!this.lastPartial && quiet > 12_000) void this.closeUtterance();
      }, 250);
    }
  }

  /** End a push-to-talk recording and return the (corrected) transcript. */
  async stopAndTranscribe(): Promise<string> {
    if (!this.active || !speech) return '';
    this.active = false;
    this.clearTimers();
    this.callbacks.onState('transcribing');
    let text = (await speech.speechStop().catch(() => this.lastPartial)) || this.lastPartial;
    text = await this.maybeCloud(text);
    text = text.trim();
    if (text) text = await correctTranscript(text, this.macroNames);
    this.callbacks.onState('idle', text ? undefined : 'nothing heard');
    return text;
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.clearTimers();
    void speech?.speechCancel().catch(() => undefined);
    this.callbacks.onState('idle');
  }

  private clearTimers(): void {
    if (this.silenceTimer) clearInterval(this.silenceTimer);
    this.silenceTimer = null;
    this.subs.forEach((s) => s.remove());
    this.subs = [];
  }

  private async closeUtterance(): Promise<void> {
    if (!this.active || !speech) return;
    this.active = false;
    this.clearTimers();
    this.callbacks.onState('transcribing');
    let text = (await speech.speechStop().catch(() => this.lastPartial)) || this.lastPartial;
    text = (await this.maybeCloud(text)).trim();
    if (this.requireWake) {
      if (!WAKE_RE.test(text)) {
        this.callbacks.onState('idle', 'no wake phrase');
        return;
      }
      text = text.replace(WAKE_RE, '').trim();
    }
    if (!text) {
      this.callbacks.onState('idle');
      return;
    }
    text = await correctTranscript(text, this.macroNames);
    this.callbacks.onUtterance(text);
  }

  /** Optional cloud transcription of the recorded WAV (OpenAI-compatible). */
  private async maybeCloud(local: string): Promise<string> {
    const cfg = useSettingsStore.getState().voice.remoteStt;
    if (!cfg.enabled || !cfg.baseUrl.trim() || !this.recordPath) return local;
    try {
      if (!(await RNFS.exists(this.recordPath))) return local;
      const form = new FormData();
      form.append('file', { uri: `file://${this.recordPath}`, name: 'utterance.wav', type: 'audio/wav' } as unknown as Blob);
      form.append('model', cfg.model.trim() || 'whisper-1');
      const res = await fetch(`${cfg.baseUrl.trim().replace(/\/$/, '')}/audio/transcriptions`, {
        method: 'POST',
        headers: cfg.apiKey.trim() ? { authorization: `Bearer ${cfg.apiKey.trim()}` } : {},
        body: form,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { text?: string };
      diag(`voice cloud stt: ${JSON.stringify((data.text ?? '').slice(0, 80))}`);
      return data.text?.trim() || local;
    } catch (err) {
      diag(`voice cloud stt failed: ${err instanceof Error ? err.message : String(err)}`);
      return local;
    }
  }

  /** Speak the agent's answer aloud; resolves when playout ends or is cut. */
  async speak(text: string): Promise<void> {
    const clean = text.replace(/[*_`#>]/g, '').replace(/\[[^\]]*\]\([^)]*\)/g, '').slice(0, 700);
    if (!clean.trim() || !alarms) return;
    this.callbacks.onState('speaking');
    const voice = useSettingsStore.getState().voice;
    try {
      if (voice.remoteTts.enabled && voice.remoteTts.baseUrl.trim()) {
        await this.speakCloud(clean, voice.remoteTts);
      } else {
        await alarms.speakSystem(clean, voice.rate, voice.systemVoiceId);
      }
    } catch (err) {
      diag(`voice tts error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.callbacks.onState('idle');
    }
  }

  private async speakCloud(text: string, cfg: { baseUrl: string; apiKey: string; model: string; voice: string }): Promise<void> {
    const res = await fetch(`${cfg.baseUrl.trim().replace(/\/$/, '')}/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cfg.apiKey.trim() ? { authorization: `Bearer ${cfg.apiKey.trim()}` } : {}) },
      body: JSON.stringify({ model: cfg.model.trim() || 'tts-1', voice: cfg.voice.trim() || 'alloy', input: text, response_format: 'mp3' }),
    });
    if (!res.ok) throw new Error(`cloud tts HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    const path = `${RNFS.CachesDirectoryPath}/tts.mp3`;
    await RNFS.writeFile(path, arrayBufferToBase64(buf), 'base64');
    await alarms!.playAudioFile(path);
  }

  async stopSpeaking(): Promise<void> {
    await alarms?.stopSystemSpeech().catch(() => undefined);
    await alarms?.stopAudio().catch(() => undefined);
    this.callbacks.onState('idle');
  }
}

export async function listSystemVoices(): Promise<{ id: string; name: string; quality: string }[]> {
  if (!alarms) return [];
  const voices = await alarms.systemVoices().catch(() => []);
  const rank = { premium: 0, enhanced: 1, default: 2 } as Record<string, number>;
  return voices.sort((a, b) => (rank[a.quality] ?? 3) - (rank[b.quality] ?? 3) || a.name.localeCompare(b.name));
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += chars[a >> 2]! + chars[((a & 3) << 4) | ((b ?? 0) >> 4)]!;
    out += b === undefined ? '=' : chars[((b & 15) << 2) | ((c ?? 0) >> 6)]!;
    out += c === undefined ? '=' : chars[c & 63]!;
  }
  return out;
}
