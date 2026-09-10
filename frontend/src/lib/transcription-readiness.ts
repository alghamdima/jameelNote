/**
 * Which speech engine a saved transcript config points at, and — for the local
 * engines — the Tauri commands that report whether their models are on disk.
 *
 * The pre-flight check that runs before recording has to ask the same engine the
 * recording itself will use. Asking Parakeet about a Whisper setup reports "no
 * models" and blocks recording even when the configured model is downloaded.
 */

export type TranscriptionEngine = 'whisper' | 'parakeet' | 'remote';

export interface ReadinessCommands {
  init: string;
  hasAvailableModels: string;
  listModels: string;
}

/**
 * Map a saved config provider onto the engine that serves it.
 *
 * A missing provider resolves to Whisper because the Rust side defaults an absent
 * transcript config to localWhisper.
 */
export function resolveTranscriptionEngine(provider?: string | null): TranscriptionEngine {
  if (provider === 'parakeet') return 'parakeet';
  if (provider === 'remoteWhisper') return 'remote';
  return 'whisper';
}

/**
 * The readiness commands for a local engine, or null for the remote gateway,
 * which has nothing on disk to check. Reachability is not checked here on
 * purpose: a network probe before every recording would block the user on a
 * transient outage, and the Rust side validates the configuration anyway.
 */
export function getReadinessCommands(engine: TranscriptionEngine): ReadinessCommands | null {
  if (engine === 'remote') {
    return null;
  }

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
