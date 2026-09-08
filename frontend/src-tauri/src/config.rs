/// Application configuration constants
///
/// Centralized definitions for default models and settings.
/// Used across database initialization, import, and retranscription.

/// Default Whisper model for transcription when no preference is configured.
///
/// large-v3 is the most accurate Whisper tier for Arabic; the q5_0 quantization
/// keeps that accuracy at roughly a third of the file size. large-v3-turbo is
/// faster but prunes the decoder from 32 layers to 4, which costs accuracy on
/// languages with less training representation, Arabic among them.
pub const DEFAULT_WHISPER_MODEL: &str = "large-v3-q5_0";

/// Default Parakeet model for transcription when no preference is configured.
/// This is the quantized version optimized for speed.
pub const DEFAULT_PARAKEET_MODEL: &str = "parakeet-tdt-0.6b-v3-int8";

/// Default summarization endpoint: the in-house OpenAI-compatible gateway.
/// The app appends "/chat/completions" to this, so it ends at "/v1".
pub const DEFAULT_SUMMARY_ENDPOINT: &str = "https://opsai.aljfs.com/v1";

/// Model identifier served by DEFAULT_SUMMARY_ENDPOINT.
pub const DEFAULT_SUMMARY_MODEL: &str = "JameelAl-3.8-flash";

/// API key for DEFAULT_SUMMARY_ENDPOINT, read from the environment at compile
/// time.
///
/// Do not replace this with a literal key. Git history is permanent, so a key
/// committed once stays retrievable even after it is deleted, and this
/// repository is currently public. Supply it as a CI secret exported as
/// JAMEELNOTE_LLM_API_KEY for release builds; when it is unset the field is
/// simply left blank and each user enters the key once in Settings.
///
/// Note that a key baked into the binary this way is still extractable by
/// anyone who has the installer, so it is only appropriate for a gateway whose
/// users would all be entitled to access it anyway.
pub const DEFAULT_SUMMARY_API_KEY: Option<&str> = option_env!("JAMEELNOTE_LLM_API_KEY");

/// Whisper model catalog with metadata for all supported models.
/// Used by both WhisperEngine::discover_models() and discover_models_standalone().
///
/// Format: (name, filename, size_mb, accuracy, speed, description)
pub const WHISPER_MODEL_CATALOG: &[(&str, &str, u32, &str, &str, &str)] = &[
    // Standard f16 models (full precision)
    ("tiny", "ggml-tiny.bin", 74, "Decent", "Very Fast", "Fastest processing, good for real-time use"),
    ("base", "ggml-base.bin", 142, "Good", "Fast", "Good balance of speed and accuracy"),
    ("small", "ggml-small.bin", 466, "Good", "Medium", "Better accuracy, moderate speed"),
    ("medium", "ggml-medium.bin", 1463, "High", "Slow", "High accuracy for professional use"),
    ("large-v3-turbo", "ggml-large-v3-turbo.bin", 1549, "High", "Medium", "Best accuracy with improved speed"),
    ("large-v3", "ggml-large-v3.bin", 2951, "High", "Slow", "Most Accurate, latest large model"),

    // Q5_1 quantized models (balanced speed/accuracy, slightly better quality than Q5_0)
    ("tiny-q5_1", "ggml-tiny-q5_1.bin", 31, "Decent", "Very Fast", "Quantized tiny model, ~50% faster processing"),
    ("base-q5_1", "ggml-base-q5_1.bin", 57, "Good", "Fast", "Quantized base model, good speed/accuracy balance"),
    ("small-q5_1", "ggml-small-q5_1.bin", 181, "Good", "Fast", "Quantized small model, faster than f16 version"),

    // Q5_0 quantized models (balanced speed/accuracy)
    ("medium-q5_0", "ggml-medium-q5_0.bin", 514, "High", "Medium", "Quantized medium model, professional quality"),
    ("large-v3-turbo-q5_0", "ggml-large-v3-turbo-q5_0.bin", 547, "High", "Medium", "Quantized large model, best balance"),
    ("large-v3-q5_0", "ggml-large-v3-q5_0.bin", 1031, "High", "Slow", "Quantized large model, high accuracy"),
];
