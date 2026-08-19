import { RunAnywhere, AudioInputs } from '@runanywhere/core';
// Deep import: mic capture is not on the SDK's public surface yet (the
// composed voice session owns it), but the component pipeline needs raw
// frames. Our SDK — safe until AudioCaptureManager gets a public export.
import { AudioCaptureManager } from '../../../../node_modules/@runanywhere/core/src/Features/VoiceSession/AudioCaptureManager';
import { registerVoiceModels, STT_MODEL_ID, TTS_MODEL_ID } from './catalog';
import { diag } from './diag';

/**
 * Voice pipeline, built from components (mic → endpointing → STT → agent →
 * TTS) instead of `voice.createSession` — the composed session cannot call
 * tools, and tools are the whole point of this app.
 *
 * Two capture modes, because they fail differently:
 *
 * PUSH TO TALK (tapping the mic) records until you tap again and transcribes
 * whatever it got. No thresholds, nothing to tune, and no way to end up
 * listening forever. Tapping stop used to call stop(), which threw the audio
 * away without transcribing — so a mic that never crossed the RMS gate left
 * you stuck on "listening" with no transcript, which is exactly what it did
 * on device.
 *
 * HANDS FREE (wake phrase) still needs endpointing, since nobody is there to
 * tap: energy-based RMS gate plus trailing silence. Utterances here are
 * commands a metre from the phone, not far-field dictation. The "E.V" phrase
 * is matched on the TRANSCRIPT: Whisper hears it as ev/evie/e v — the regex
 * covers the family.
 */

export type VoiceState = 'idle' | 'preparing' | 'listening' | 'transcribing' | 'speaking';

const SAMPLE_RATE = 16_000;
/** Int16 RMS above this counts as speech (headroom over phone-room noise). */
const SPEECH_RMS = 900;
/** Must hear at least this much speech before an utterance can close. */
const MIN_SPEECH_MS = 350;
/** Utterance closes after this much trailing quiet. */
const TRAIL_SILENCE_MS = 900;
/** Hard cap so a noisy room cannot record forever (hands-free endpointing). */
const MAX_UTTERANCE_MS = 15_000;
/** Push-to-talk cap: you are holding the conversation, so it is generous. */
const MAX_PUSH_TO_TALK_MS = 120_000;

const WAKE_RE = /^\s*(hey |ok |okay )?(e\.?\s?v\.?|evie|ee\s?vee)[,.!?\s]+/i;

let voiceReady = false;

/** Register + download + load the voice pack. Idempotent; safe to re-call. */
export async function ensureVoiceReady(
  onProgress: (label: string) => void,
): Promise<void> {
  if (voiceReady) return;
  onProgress('preparing voice…');
  await registerVoiceModels();
  const downloadedIds = new Set(
    (await RunAnywhere.models.list({ downloadedOnly: true }).catch(() => [])).map((m) => m.id),
  );
  for (const id of [STT_MODEL_ID, TTS_MODEL_ID]) {
    if (!downloadedIds.has(id)) {
      onProgress(`downloading ${id === STT_MODEL_ID ? 'ears' : 'voice'}…`);
      for await (const ev of RunAnywhere.models.download(id)) {
        if (ev.type === 'progress' && typeof ev.percent === 'number') {
          onProgress(`downloading ${id === STT_MODEL_ID ? 'ears' : 'voice'} ${Math.round(ev.percent)}%`);
        }
        if (ev.type === 'failed') throw new Error(`voice model download failed: ${id}`);
      }
    }
    await RunAnywhere.models.load(id);
  }
  voiceReady = true;
  onProgress('');
}

export interface VoiceCallbacks {
  onState: (state: VoiceState, detail?: string) => void;
  /** Final transcript of one utterance (wake phrase already stripped). */
  onUtterance: (text: string) => void;
}

export class VoicePipeline {
  private capture = new AudioCaptureManager();
  private frames: Int16Array[] = [];
  private speechMs = 0;
  private silenceMs = 0;
  private totalMs = 0;
  private heardSpeech = false;
  private active = false;
  private requireWake = false;
  /** True while recording a tap-to-talk utterance (no auto-endpointing). */
  private pushToTalk = false;

  constructor(private callbacks: VoiceCallbacks) {}

  setRequireWake(on: boolean): void {
    this.requireWake = on;
  }

  get listening(): boolean {
    return this.active;
  }

  async start(options: { pushToTalk?: boolean } = {}): Promise<void> {
    if (this.active) return;
    const granted = await this.capture.requestPermission();
    if (!granted) throw new Error('Microphone permission denied — enable it in Settings.');
    this.reset();
    this.pushToTalk = options.pushToTalk ?? false;
    this.active = true;
    this.callbacks.onState('listening');
    await this.capture.startRecording((chunk) => this.onChunk(chunk));
  }

  /**
   * End a push-to-talk recording and transcribe everything captured.
   * Returns '' when there was nothing usable. Unlike stop(), this never
   * discards audio — the tap that ends the recording is the whole point.
   */
  async stopAndTranscribe(): Promise<string> {
    if (!this.active) return '';
    this.active = false;
    this.capture.stopRecording();
    if (this.totalMs < 250 || this.frames.length === 0) {
      this.callbacks.onState('idle', 'too short');
      return '';
    }
    this.callbacks.onState('transcribing');
    const text = await this.transcribeBuffered();
    this.callbacks.onState('idle');
    return text;
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.capture.stopRecording();
    this.callbacks.onState('idle');
  }

  private reset(): void {
    this.frames = [];
    this.speechMs = 0;
    this.silenceMs = 0;
    this.totalMs = 0;
    this.heardSpeech = false;
  }

  private onChunk(chunk: Uint8Array): void {
    if (!this.active) return;
    const samples = new Int16Array(chunk.buffer, chunk.byteOffset, Math.floor(chunk.byteLength / 2));
    const ms = (samples.length / SAMPLE_RATE) * 1000;
    this.totalMs += ms;

    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
    const rms = Math.sqrt(sum / Math.max(1, samples.length));

    if (rms >= SPEECH_RMS) {
      this.heardSpeech = true;
      this.speechMs += ms;
      this.silenceMs = 0;
    } else if (this.heardSpeech) {
      this.silenceMs += ms;
    }
    // Push-to-talk keeps every frame: the user decides where the utterance
    // ends, so there is no reason to gamble on an energy gate. Hands-free
    // buffers once speech starts (plus a short lead-in). Copy either way —
    // the native side may reuse the underlying buffer between callbacks.
    if (this.pushToTalk || this.heardSpeech || this.frames.length < 8) {
      this.frames.push(samples.slice());
    }

    if (this.pushToTalk) {
      if (this.totalMs >= MAX_PUSH_TO_TALK_MS) void this.closeUtterance();
      return;
    }

    const shouldClose =
      (this.heardSpeech && this.speechMs >= MIN_SPEECH_MS && this.silenceMs >= TRAIL_SILENCE_MS) ||
      this.totalMs >= MAX_UTTERANCE_MS;
    if (shouldClose) void this.closeUtterance();
  }

  private async closeUtterance(): Promise<void> {
    if (!this.active) return;
    this.active = false;
    this.capture.stopRecording();

    if (!this.heardSpeech || this.speechMs < MIN_SPEECH_MS) {
      this.callbacks.onState('idle');
      return;
    }

    this.callbacks.onState('transcribing');
    const text = await this.transcribeBuffered();
    if (text === '') {
      this.callbacks.onState('idle');
      return;
    }
    this.callbacks.onUtterance(text);
  }

  /**
   * Transcribe whatever is buffered and return it, applying the wake-phrase
   * gate when one is required. Returns '' for silence, a failed transcription,
   * or a missing wake phrase — the caller decides what that means.
   */
  private async transcribeBuffered(): Promise<string> {
    const total = this.frames.reduce((n, f) => n + f.length, 0);
    const pcm = new Int16Array(total);
    let offset = 0;
    for (const f of this.frames) {
      pcm.set(f, offset);
      offset += f.length;
    }
    this.frames = [];
    diag(`voice transcribing ${Math.round(this.totalMs)}ms (${total} samples)`);

    try {
      const result = await RunAnywhere.stt.transcribe(
        AudioInputs.pcm16(new Uint8Array(pcm.buffer), SAMPLE_RATE),
      );
      let text = result.text.trim();
      diag(`voice heard: ${JSON.stringify(text.slice(0, 120))}`);
      if (this.requireWake) {
        if (!WAKE_RE.test(text)) {
          this.callbacks.onState('idle', 'no wake phrase');
          return '';
        }
        text = text.replace(WAKE_RE, '').trim();
      }
      return text;
    } catch (err) {
      diag(`voice stt error: ${err instanceof Error ? err.message : String(err)}`);
      this.callbacks.onState('idle', 'transcription failed');
      return '';
    }
  }

  /** Speak the agent's answer aloud; resolves when playout ends or is cut. */
  async speak(text: string): Promise<void> {
    const clean = text.replace(/[*_`#>]/g, '').slice(0, 600);
    if (!clean.trim()) return;
    this.callbacks.onState('speaking');
    try {
      const handle = RunAnywhere.tts.speak(clean);
      await handle.waitForPlayout();
    } catch (err) {
      diag(`voice tts error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.callbacks.onState('idle');
    }
  }

  async stopSpeaking(): Promise<void> {
    await RunAnywhere.tts.stop().catch(() => undefined);
    this.callbacks.onState('idle');
  }
}
