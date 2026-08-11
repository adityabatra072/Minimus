import { RunAnywhere, SDKEnvironment } from '@runanywhere/core';
import { LlamaCPP } from '@runanywhere/llamacpp';
import { registerCatalog } from './catalog';

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
