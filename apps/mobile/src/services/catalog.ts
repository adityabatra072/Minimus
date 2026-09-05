import { RunAnywhere } from '@runanywhere/core';
import { InferenceFramework, ModelCategory } from '@runanywhere/proto-ts/model_types';

/**
 * Voice pack: sherpa-onnx models the voice pipeline needs, downloaded and
 * extracted by the RunAnywhere SDK (they ship as tar.gz bundles). Language
 * and vision models live in services/models.ts.
 */
export const STT_MODEL_ID = 'sherpa-whisper-tiny-en';
export const TTS_MODEL_ID = 'piper-en-us-lessac-medium';

const VOICE_MODELS = [
  {
    id: STT_MODEL_ID,
    name: 'Whisper Tiny EN (speech-to-text)',
    url: 'https://github.com/RunanywhereAI/sherpa-onnx/releases/download/runanywhere-models-v1/sherpa-onnx-whisper-tiny.en.tar.gz',
    category: ModelCategory.MODEL_CATEGORY_SPEECH_RECOGNITION,
    memoryRequirementBytes: 120_000_000,
  },
  {
    id: TTS_MODEL_ID,
    name: 'Piper Lessac (text-to-speech)',
    url: 'https://github.com/RunanywhereAI/sherpa-onnx/releases/download/runanywhere-models-v1/vits-piper-en_US-lessac-medium.tar.gz',
    category: ModelCategory.MODEL_CATEGORY_SPEECH_SYNTHESIS,
    memoryRequirementBytes: 100_000_000,
  },
];

export async function registerVoiceModels(): Promise<void> {
  for (const entry of VOICE_MODELS) {
    await RunAnywhere.models
      .register({
        id: entry.id,
        name: entry.name,
        url: entry.url,
        framework: InferenceFramework.INFERENCE_FRAMEWORK_ONNX,
        category: entry.category,
        memoryRequirementBytes: entry.memoryRequirementBytes,
      })
      .catch(() => undefined); // already registered on a previous launch
  }
}
