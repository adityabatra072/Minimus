import { RunAnywhere, SDKEnvironment } from '@runanywhere/core';
import { LlamaCPP } from '@runanywhere/llamacpp';
import { registerCatalog } from './catalog';

// ONNX (sherpa STT/TTS/VAD) is optional at runtime — voice features degrade
// gracefully when the backend is absent from a build.
let ONNX: { register: () => Promise<boolean | void> | void } | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  ONNX = (require('@runanywhere/onnx') as { ONNX: typeof ONNX }).ONNX;
} catch {
  ONNX = null;
}

/**
 * Two-phase SDK bootstrap, mirroring the reference apps:
 * backends register BEFORE initialize, catalog after.
 * Keyless development mode — telemetry/registration stay local.
 */

let initialized = false;

export async function initSdk(): Promise<void> {
  if (initialized) return;

  const llamaOk = (await LlamaCPP.register()) !== false;
  if (!llamaOk) {
    throw new Error('LlamaCPP backend failed to register — on-device LLM unavailable');
  }
  if (ONNX) {
    try {
      await ONNX.register();
    } catch (e) {
      console.warn('[sdk] ONNX backend unavailable — voice features disabled', e);
    }
  }

  await RunAnywhere.initialize({
    apiKey: '',
    baseUrl: '',
    environment: SDKEnvironment.SDK_ENVIRONMENT_DEVELOPMENT,
  });

  await registerCatalog();
  initialized = true;
}

export function sdkVersion(): string {
  return RunAnywhere.version;
}
