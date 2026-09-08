/**
 * Which local speech engine a saved transcript config points at, and the Tauri
 * commands that report whether its models are on disk.
 *
 * The pre-flight check that runs before recording has to ask the same engine the
 * recording itself will use. Asking Parakeet about a Whisper setup reports "no
 * models" and blocks recording even when the configured model is downloaded.
 */

export type TranscriptionEngine = 'whisper' | 'parakeet';

export interface ReadinessCommands {
  init: string;
  hasAvailableModels: string;
  listModels: string;
}

/**
 * Map a saved config provider onto the local engine that serves it.
 *
 * Everything that is not Parakeet is served by Whisper, including a missing
 * provider: the Rust side defaults an absent transcript config to localWhisper.
 */
export function resolveTranscriptionEngine(provider?: string | null): TranscriptionEngine {
  return provider === 'parakeet' ? 'parakeet' : 'whisper';
}

export function getReadinessCommands(engine: TranscriptionEngine): ReadinessCommands {
  return engine === 'parakeet'
    ? {
        init: 'parakeet_init',
        hasAvailableModels: 'parakeet_has_available_models',
        listModels: 'parakeet_get_available_models',
      }
    : {
        init: 'whisper_init',
        hasAvailableModels: 'whisper_has_available_models',
        listModels: 'whisper_get_available_models',
      };
}

/**
 * Rust serializes ModelStatus::Downloading as `{ Downloading: { progress } }`
 * and the unit variants as plain strings, so both shapes have to be handled.
 */
export function isAnyModelDownloading(models?: Array<{ status?: unknown }> | null): boolean {
  if (!Array.isArray(models)) {
    return false;
  }

  return models.some((model) => {
    const status = model?.status;
    if (!status) {
      return false;
    }
    return typeof status === 'object' ? 'Downloading' in (status as object) : status === 'Downloading';
  });
}
