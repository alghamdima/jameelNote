// audio/transcription/remote_provider.rs
//
// TranscriptionProvider backed by an OpenAI-compatible /audio/transcriptions
// endpoint (the in-house LiteLLM gateway by default).

use async_trait::async_trait;
use log::{debug, info, warn};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use super::provider::{TranscriptResult, TranscriptionError, TranscriptionProvider};
use super::remote_config::RemoteTranscriptionConfig;
use super::wav::encode_wav_16k_mono;

/// Shortest clip worth sending. Matches the VAD's own minimum segment length in
/// pipeline.rs, so this provider drops exactly what the local engines drop and no
/// more.
const MIN_SAMPLES: usize = 800;

/// Consecutive failures before the breaker opens. See `transcribe`.
const BREAKER_THRESHOLD: u32 = 5;
const BREAKER_COOLDOWN: Duration = Duration::from_secs(30);

/// Longest backoff between attempts.
const MAX_BACKOFF: Duration = Duration::from_secs(4);

/// Bytes of an error body to keep in a log line or error message.
const MAX_BODY_SNIPPET: usize = 300;

/// Which endpoint a given language preference maps to.
enum Route {
    /// Transcribe in the source language. `None` lets the model auto-detect.
    Transcribe(Option<String>),
    /// Translate to English — a separate endpoint, not a `language` value.
    Translate,
}

/// Result of a single HTTP attempt.
enum Outcome {
    Ok(String),
    /// Transient; worth another attempt. Carries an optional server-requested delay.
    Retryable(String, Option<Duration>),
    /// Permanent for this audio and this configuration; retrying only wastes time.
    Terminal(String),
}

pub struct RemoteTranscriptionProvider {
    /// One client for the life of the provider, so connections and TLS sessions
    /// are reused across chunks instead of re-handshaking every few seconds.
    client: reqwest::Client,
    transcriptions_url: String,
    translations_url: String,
    api_key: Option<String>,
    model: String,
    max_attempts: u32,

    consecutive_failures: AtomicU32,
    breaker_open_until: Mutex<Option<Instant>>,
}

impl RemoteTranscriptionProvider {
    pub fn new(config: RemoteTranscriptionConfig) -> Result<Self, String> {
        let base = config.endpoint.trim().trim_end_matches('/');
        if base.is_empty() {
            return Err("Transcription endpoint is empty".to_string());
        }
        if !base.starts_with("http://") && !base.starts_with("https://") {
            return Err(format!(
                "Transcription endpoint must start with http:// or https:// (got '{}')",
                base
            ));
        }

        let timeout = Duration::from_secs(
            config
                .timeout_secs
                .unwrap_or(crate::config::DEFAULT_REMOTE_TIMEOUT_SECS),
        );

        let client = reqwest::Client::builder()
            .timeout(timeout)
            .pool_idle_timeout(Duration::from_secs(90))
            .build()
            .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

        Ok(Self {
            client,
            transcriptions_url: format!("{}/audio/transcriptions", base),
            translations_url: format!("{}/audio/translations", base),
            // A blank key field means "use the built-in key" rather than "send no
            // key" — otherwise clearing the field in Settings would produce
            // unauthenticated requests instead of working ones.
            api_key: config
                .api_key
                .filter(|k| !k.trim().is_empty())
                .or_else(|| crate::config::DEFAULT_TRANSCRIPTION_API_KEY.map(str::to_string)),
            model: config.model,
            max_attempts: config
                .max_attempts
                .unwrap_or(crate::config::DEFAULT_REMOTE_MAX_ATTEMPTS)
                .max(1),
            consecutive_failures: AtomicU32::new(0),
            breaker_open_until: Mutex::new(None),
        })
    }

    /// Map this app's language preference onto an endpoint and parameters.
    ///
    /// `LANGUAGE_PREFERENCE` carries the sentinels "auto" and "auto-translate",
    /// neither of which is a valid value for the OpenAI `language` field.
    fn route_for(language: Option<&str>) -> Route {
        match language.map(str::trim) {
            // Auto-detection is expressed by omitting `language` entirely.
            None | Some("") | Some("auto") => Route::Transcribe(None),
            // Translate-to-English is a different endpoint, not a language code.
            Some("auto-translate") => Route::Translate,
            Some(code) => Route::Transcribe(Some(code.to_string())),
        }
    }

    /// Build the multipart body.
    ///
    /// Must be called once per attempt: `reqwest::multipart::Form` is not `Clone`
    /// and is consumed by `.multipart()`, so a form hoisted out of the retry loop
    /// cannot be resent.
    fn build_form(&self, wav: Vec<u8>, language: Option<&str>) -> reqwest::multipart::Form {
        let part = reqwest::multipart::Part::bytes(wav)
            // The filename matters: several OpenAI-compatible servers pick a
            // decoder from the extension before they look at the MIME type.
            .file_name("audio.wav")
            .mime_str("audio/wav")
            .expect("audio/wav is a valid MIME string");

        let mut form = reqwest::multipart::Form::new()
            .part("file", part)
            .text("model", self.model.clone())
            // "json" gives {"text": "..."}. Not "verbose_json": segment timings
            // are unused here and proxy support for them varies. Not "text": a
            // bare body is hard to tell apart from an error page.
            .text("response_format", "json");

        if let Some(code) = language {
            form = form.text("language", code.to_string());
        }

        // `temperature` is deliberately omitted: the server default is already
        // greedy, and some strict proxies reject "0" arriving as a multipart
        // string field where they expect a float.
        form
    }

    async fn attempt(&self, url: &str, wav: Vec<u8>, language: Option<&str>) -> Outcome {
        let mut request = self.client.post(url).multipart(self.build_form(wav, language));

        if let Some(key) = &self.api_key {
            request = request.header("Authorization", format!("Bearer {}", key));
        }

        let response = match request.send().await {
            Ok(response) => response,
            Err(e) if e.is_timeout() || e.is_connect() || e.is_request() => {
                return Outcome::Retryable(format!("network error: {}", e), None);
            }
            Err(e) => return Outcome::Terminal(format!("network error: {}", e)),
        };

        let status = response.status();
        let retry_after = response
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok())
            .map(Duration::from_secs);
        let body = response.text().await.unwrap_or_default();

        if status.is_success() {
            // Accept only a JSON object carrying a string `text`. Anything else —
            // including an HTML error page served with 200 — is a failure, not a
            // transcript.
            return match serde_json::from_str::<serde_json::Value>(&body) {
                Ok(json) => match json.get("text").and_then(|t| t.as_str()) {
                    Some(text) => Outcome::Ok(text.to_string()),
                    None => Outcome::Terminal(format!(
                        "response has no string 'text' field: {}",
                        snippet(&body)
                    )),
                },
                Err(e) => Outcome::Terminal(format!(
                    "invalid JSON response: {} ({})",
                    e,
                    snippet(&body)
                )),
            };
        }

        let code = status.as_u16();
        match code {
            // Overload, rate limiting, gateway restarts, proxy hiccups.
            408 | 409 | 425 | 429 | 500 | 502 | 503 | 504 => {
                Outcome::Retryable(format!("HTTP {}: {}", code, snippet(&body)), retry_after)
            }
            // 401/403 a bad key, 404 a wrong path or unknown model, 413/415/422
            // audio that will never be accepted, 400 bad parameters. Retrying any
            // of these just burns the shutdown budget.
            _ if status.is_client_error() => {
                Outcome::Terminal(format!("HTTP {}: {}", code, snippet(&body)))
            }
            _ => Outcome::Retryable(format!("HTTP {}: {}", code, snippet(&body)), retry_after),
        }
    }

    /// True when the breaker is open and the cooldown has not yet elapsed.
    fn breaker_is_open(&self) -> bool {
        let mut guard = match self.breaker_open_until.lock() {
            Ok(guard) => guard,
            // A poisoned lock should not take transcription down with it.
            Err(poisoned) => poisoned.into_inner(),
        };

        match *guard {
            Some(until) if Instant::now() < until => true,
            Some(_) => {
                // Cooldown elapsed: let one request through as a probe.
                *guard = None;
                false
            }
            None => false,
        }
    }

    fn record_success(&self) {
        self.consecutive_failures.store(0, Ordering::SeqCst);
        if let Ok(mut guard) = self.breaker_open_until.lock() {
            *guard = None;
        }
    }

    fn record_failure(&self) {
        let failures = self.consecutive_failures.fetch_add(1, Ordering::SeqCst) + 1;
        if failures >= BREAKER_THRESHOLD {
            if let Ok(mut guard) = self.breaker_open_until.lock() {
                *guard = Some(Instant::now() + BREAKER_COOLDOWN);
            }
            warn!(
                "☁️ Remote transcription breaker opened after {} consecutive failures; \
                 skipping chunks for {}s",
                failures,
                BREAKER_COOLDOWN.as_secs()
            );
        }
    }
}

fn snippet(body: &str) -> String {
    let trimmed = body.trim();
    if trimmed.len() <= MAX_BODY_SNIPPET {
        trimmed.to_string()
    } else {
        // Slice on a char boundary; error bodies may be UTF-8.
        let end = trimmed
            .char_indices()
            .take_while(|(i, _)| *i <= MAX_BODY_SNIPPET)
            .last()
            .map(|(i, _)| i)
            .unwrap_or(0);
        format!("{}…", &trimmed[..end])
    }
}

/// Exponential backoff, honouring a server-supplied Retry-After when it is not
/// longer than our own cap.
///
/// No jitter: the live worker is serial, so there is no herd to spread out.
fn backoff_for(attempt: u32, retry_after: Option<Duration>) -> Duration {
    let base = Duration::from_millis(500 * 2u64.saturating_pow(attempt.saturating_sub(1)));
    let base = base.min(MAX_BACKOFF);
    match retry_after {
        Some(requested) if requested <= MAX_BACKOFF => requested.max(base),
        _ => base,
    }
}

#[async_trait]
impl TranscriptionProvider for RemoteTranscriptionProvider {
    async fn transcribe(
        &self,
        audio: Vec<f32>,
        language: Option<String>,
    ) -> std::result::Result<TranscriptResult, TranscriptionError> {
        if audio.len() < MIN_SAMPLES {
            return Err(TranscriptionError::AudioTooShort {
                samples: audio.len(),
                minimum: MIN_SAMPLES,
            });
        }

        // Fail fast during an outage. Without this, three attempts at a 30s
        // timeout hold the single live worker for over a minute per chunk while
        // VAD keeps pushing into an unbounded queue — which surfaces at shutdown
        // as a chunk-loss warning and a recording that takes minutes to stop.
        if self.breaker_is_open() {
            return Err(TranscriptionError::EngineFailed(
                "Transcription gateway unavailable; chunk skipped".to_string(),
            ));
        }

        let (mut url, mut language_field) = match Self::route_for(language.as_deref()) {
            Route::Transcribe(code) => (self.transcriptions_url.clone(), code),
            Route::Translate => (self.translations_url.clone(), None),
        };
        let mut translation_fallback_used = false;

        let wav = encode_wav_16k_mono(&audio);
        debug!(
            "☁️ Sending {} samples ({} bytes WAV) to {}",
            audio.len(),
            wav.len(),
            url
        );

        let mut last_error = String::from("no attempts made");

        for attempt in 1..=self.max_attempts {
            // Bound to a local first: as a `match` scrutinee, the borrows of `url`
            // and `language_field` would live for the whole match and collide with
            // the reassignment in the translation-fallback arm below.
            let outcome = self
                .attempt(&url, wav.clone(), language_field.as_deref())
                .await;

            match outcome {
                Outcome::Ok(text) => {
                    self.record_success();
                    return Ok(TranscriptResult {
                        text: text.trim().to_string(),
                        // The endpoint reports no per-segment confidence.
                        confidence: None,
                        is_partial: false,
                    });
                }
                Outcome::Terminal(message) => {
                    // A gateway that does not expose /audio/translations should
                    // still produce a transcript rather than dropping the chunk.
                    if !translation_fallback_used
                        && url == self.translations_url
                        && (message.starts_with("HTTP 404") || message.starts_with("HTTP 405"))
                    {
                        warn!(
                            "☁️ Gateway has no /audio/translations route ({}); \
                             falling back to transcription in the source language",
                            message
                        );
                        url = self.transcriptions_url.clone();
                        language_field = None;
                        translation_fallback_used = true;
                        // Recorded so that exhausting the attempt budget here
                        // reports the 404 rather than "no attempts made".
                        last_error = message;
                        continue;
                    }

                    self.record_failure();
                    return Err(TranscriptionError::EngineFailed(describe(&message)));
                }
                Outcome::Retryable(message, retry_after) => {
                    last_error = message;
                    if attempt < self.max_attempts {
                        let delay = backoff_for(attempt, retry_after);
                        warn!(
                            "☁️ Transcription attempt {}/{} failed ({}); retrying in {:?}",
                            attempt, self.max_attempts, last_error, delay
                        );
                        tokio::time::sleep(delay).await;
                    }
                }
            }
        }

        self.record_failure();
        Err(TranscriptionError::EngineFailed(format!(
            "Transcription failed after {} attempts: {}",
            self.max_attempts, last_error
        )))
    }

    /// Called once per chunk by the worker, where `false` drops the chunk with no
    /// event at all — so this must never do IO and never depend on transient
    /// connectivity. Reachability is reported through transcription errors instead.
    async fn is_model_loaded(&self) -> bool {
        true
    }

    async fn get_current_model(&self) -> Option<String> {
        Some(self.model.clone())
    }

    fn provider_name(&self) -> &'static str {
        "RemoteWhisper"
    }
}

/// Turn a raw failure into something a user can act on.
fn describe(message: &str) -> String {
    if message.starts_with("HTTP 401") || message.starts_with("HTTP 403") {
        format!(
            "Transcription authentication failed — check the API key in Settings. ({})",
            message
        )
    } else if message.starts_with("HTTP 404") {
        format!(
            "Transcription endpoint or model not found — check the endpoint URL and model name in Settings. ({})",
            message
        )
    } else if message.starts_with("HTTP 413") {
        format!("Audio segment rejected as too large by the gateway. ({})", message)
    } else {
        format!("Transcription failed: {}", message)
    }
}

/// Log the effective configuration once, without leaking the key.
pub fn log_configuration(config: &RemoteTranscriptionConfig) {
    info!(
        "☁️ Remote transcription: endpoint={}, model={}, key={}",
        config.endpoint,
        config.model,
        match config.api_key.as_deref().filter(|k| !k.trim().is_empty()) {
            Some(_) => "configured",
            None if crate::config::DEFAULT_TRANSCRIPTION_API_KEY.is_some() => "built-in",
            None => "none",
        }
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> RemoteTranscriptionConfig {
        RemoteTranscriptionConfig {
            endpoint: "https://example.test/v1".to_string(),
            api_key: Some("key".to_string()),
            model: "whisper-1".to_string(),
            timeout_secs: None,
            max_attempts: None,
            batch_concurrency: None,
        }
    }

    #[test]
    fn endpoint_must_be_http() {
        let mut cfg = config();
        cfg.endpoint = "example.test/v1".to_string();
        assert!(RemoteTranscriptionProvider::new(cfg).is_err());
    }

    #[test]
    fn trailing_slash_does_not_double_up() {
        let mut cfg = config();
        cfg.endpoint = "https://example.test/v1/".to_string();
        let provider = RemoteTranscriptionProvider::new(cfg).unwrap();
        assert_eq!(
            provider.transcriptions_url,
            "https://example.test/v1/audio/transcriptions"
        );
    }

    #[test]
    fn language_sentinels_map_to_the_right_route() {
        // "auto" must omit the field, not send the literal string.
        assert!(matches!(
            RemoteTranscriptionProvider::route_for(Some("auto")),
            Route::Transcribe(None)
        ));
        assert!(matches!(
            RemoteTranscriptionProvider::route_for(None),
            Route::Transcribe(None)
        ));
        assert!(matches!(
            RemoteTranscriptionProvider::route_for(Some("auto-translate")),
            Route::Translate
        ));
        match RemoteTranscriptionProvider::route_for(Some("ar")) {
            Route::Transcribe(Some(code)) => assert_eq!(code, "ar"),
            _ => panic!("expected a language code to pass through"),
        }
    }

    #[test]
    fn blank_key_falls_back_rather_than_sending_none() {
        let mut cfg = config();
        cfg.api_key = Some("   ".to_string());
        let provider = RemoteTranscriptionProvider::new(cfg).unwrap();
        assert_eq!(
            provider.api_key,
            crate::config::DEFAULT_TRANSCRIPTION_API_KEY.map(str::to_string)
        );
    }

    #[test]
    fn backoff_grows_and_stays_capped() {
        assert_eq!(backoff_for(1, None), Duration::from_millis(500));
        assert_eq!(backoff_for(2, None), Duration::from_millis(1000));
        assert_eq!(backoff_for(9, None), MAX_BACKOFF);
        // An unreasonable Retry-After is ignored in favour of our own cap.
        assert_eq!(backoff_for(1, Some(Duration::from_secs(600))), Duration::from_millis(500));
        assert_eq!(backoff_for(1, Some(Duration::from_secs(2))), Duration::from_secs(2));
    }

    #[tokio::test]
    async fn short_audio_is_rejected_without_a_request() {
        let provider = RemoteTranscriptionProvider::new(config()).unwrap();
        let result = provider.transcribe(vec![0.0; 799], None).await;
        assert!(matches!(
            result,
            Err(TranscriptionError::AudioTooShort { minimum: 800, .. })
        ));
    }

    #[test]
    fn breaker_opens_after_repeated_failures() {
        let provider = RemoteTranscriptionProvider::new(config()).unwrap();
        assert!(!provider.breaker_is_open());
        for _ in 0..BREAKER_THRESHOLD {
            provider.record_failure();
        }
        assert!(provider.breaker_is_open());

        provider.record_success();
        assert!(!provider.breaker_is_open());
    }
}
