// audio/transcription/remote_config.rs
//
// Configuration for the remote OpenAI-compatible transcription gateway.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

use crate::database::repositories::setting::SettingsRepository;
use crate::state::AppState;

/// Remote OpenAI-compatible transcription endpoint configuration.
///
/// Stored as JSON in `transcript_settings.transcriptCustomConfig`, mirroring how
/// the summary side stores `settings.customOpenAIConfig`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteTranscriptionConfig {
    /// Base URL, ending at "/v1". "/audio/transcriptions" is appended to it.
    pub endpoint: String,

    /// When absent or blank the compile-time key is used, and when that is also
    /// absent no Authorization header is sent at all.
    #[serde(rename = "apiKey")]
    pub api_key: Option<String>,

    /// Model identifier served by `endpoint`.
    pub model: String,

    // Tuning knobs. `None` means "use the config.rs default". These carry
    // `#[serde(default)]` because a blob written by an older build will not
    // contain them, and without it deserialization of that blob fails.
    #[serde(rename = "timeoutSecs", default, skip_serializing_if = "Option::is_none")]
    pub timeout_secs: Option<u64>,

    #[serde(rename = "maxAttempts", default, skip_serializing_if = "Option::is_none")]
    pub max_attempts: Option<u32>,

    #[serde(rename = "batchConcurrency", default, skip_serializing_if = "Option::is_none")]
    pub batch_concurrency: Option<usize>,
}

impl RemoteTranscriptionConfig {
    /// The built-in gateway configuration, used when nothing is stored.
    pub fn defaults() -> Self {
        Self {
            endpoint: crate::config::DEFAULT_TRANSCRIPTION_ENDPOINT.to_string(),
            api_key: crate::config::DEFAULT_TRANSCRIPTION_API_KEY.map(str::to_string),
            model: crate::config::DEFAULT_TRANSCRIPTION_MODEL.to_string(),
            timeout_secs: None,
            max_attempts: None,
            batch_concurrency: None,
        }
    }
}

/// Reads the stored configuration, falling back to the compile-time defaults for
/// anything unset.
///
/// Deliberately never fails on "not configured": a fresh install that has not yet
/// written the blob must still be able to transcribe.
pub async fn resolve_remote_config<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<RemoteTranscriptionConfig, String> {
    let app_state = app
        .try_state::<AppState>()
        .ok_or_else(|| "App state not available".to_string())?;

    let stored = SettingsRepository::get_remote_transcription_config(app_state.db_manager.pool())
        .await
        .map_err(|e| format!("Failed to read remote transcription config: {}", e))?;

    Ok(stored.unwrap_or_else(RemoteTranscriptionConfig::defaults))
}
