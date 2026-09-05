import { RunAnywhere, SDKEnvironment } from '@runanywhere/core';
import { registerVoiceModels } from './catalog';
import { diag } from './diag';

/**
 * The RunAnywhere SDK now serves ONE purpose here: the sherpa-onnx voice
 * pipeline (Whisper speech-to-text, Piper text-to-speech). Language and vision
 * models run through services/engine.ts and services/vision.ts.
 *
 * It initialises lazily, on the first voice interaction, instead of at boot:
 * boot used to wait on the SDK's network phase before the chat could open.
 */

let ONNX: { register: () => Promise<boolean | void> | void } | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  ONNX = (require('@runanywhere/onnx') as { ONNX: typeof ONNX }).ONNX;
} catch {
  ONNX = null;
}

let ready: Promise<void> | null = null;

export function ensureVoiceSdk(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    const started = Date.now();
    if (!ONNX) throw new Error('the voice backend is not part of this build');
    await ONNX.register();
    await RunAnywhere.initialize({
      apiKey: '',
      baseUrl: '',
      environment: SDKEnvironment.SDK_ENVIRONMENT_DEVELOPMENT,
    });
    await registerVoiceModels();
    diag(`voice sdk ready in ${Date.now() - started}ms`);
  })();
  ready.catch(() => {
    ready = null;
  });
  return ready;
}

export function voiceAvailable(): boolean {
  return ONNX !== null;
}
