// audio/transcription/remote_config.rs
//
// Configuration for the remote OpenAI-compatible transcription gateway.

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
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

    /// When absent or blank, the built-in key is used for the default gateway,
    /// and no Authorization header is sent to any other server.
    #[serde(rename = "apiKey")]
    pub api_key: Option<String>,

    /// Model identifier served by `endpoint`.
    pub model: String,

    /// Use the Summary engine's endpoint and API key instead of `endpoint` and
    /// `api_key`, so the key only has to be entered once. `None` — which is what a
    /// blob written before this option existed contains — means shared.
    ///
    /// `endpoint` and `api_key` are still kept while sharing, so turning it off
    /// restores whatever was configured before.
    #[serde(rename = "shareSummaryConnection", default, skip_serializing_if = "Option::is_none")]
    pub share_summary_connection: Option<bool>,

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
    ///
    /// The key is left unset rather than copied from the build: the provider falls
    /// back to the built-in key at runtime, so a later build carrying a new key
    /// takes effect without rewriting anyone's stored settings.
    pub fn defaults() -> Self {
        Self {
            endpoint: crate::config::DEFAULT_TRANSCRIPTION_ENDPOINT.to_string(),
            api_key: None,
            model: crate::config::DEFAULT_TRANSCRIPTION_MODEL.to_string(),
            share_summary_connection: None,
            timeout_secs: None,
            max_attempts: None,
            batch_concurrency: None,
        }
    }

    /// Whether the Summary engine's endpoint and key are used; shared by default.
    pub fn shares_summary_connection(&self) -> bool {
        self.share_summary_connection.unwrap_or(true)
    }
}

/// The Summary engine's custom server endpoint and key, if one is configured.
///
/// Returns `None` when no custom server is saved or its endpoint is blank, so
/// callers keep their own values rather than switching to an empty URL.
pub async fn summary_connection(pool: &SqlitePool) -> Option<(String, Option<String>)> {
    match SettingsRepository::get_custom_openai_config(pool).await {
        Ok(Some(config)) if !config.endpoint.trim().is_empty() => Some((
            config.endpoint.trim().to_string(),
            config.api_key.filter(|key| !key.trim().is_empty()),
        )),
        Ok(_) => None,
        Err(e) => {
            log::warn!("Could not read the Summary server config to share it: {}", e);
            None
        }
    }
}

/// Reads the stored configuration, falling back to the compile-time defaults for
/// anything unset, and applies the Summary connection when it is shared.
///
/// Deliberately never fails on "not configured": a fresh install that has not yet
/// written the blob must still be able to transcribe.
pub async fn resolve_remote_config<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<RemoteTranscriptionConfig, String> {
    let app_state = app
        .try_state::<AppState>()
        .ok_or_else(|| "App state not available".to_string())?;
    let pool = app_state.db_manager.pool();

    let mut config = SettingsRepository::get_remote_transcription_config(pool)
        .await
        .map_err(|e| format!("Failed to read remote transcription config: {}", e))?
        .unwrap_or_else(RemoteTranscriptionConfig::defaults);

    if config.shares_summary_connection() {
        if let Some((endpoint, api_key)) = summary_connection(pool).await {
            config.endpoint = endpoint;
            config.api_key = api_key;
        }
    }

    Ok(config)
}
