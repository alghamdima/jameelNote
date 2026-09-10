-- Remote OpenAI-compatible transcription gateway configuration.
--
-- Stores {endpoint, apiKey, model, ...} as JSON, mirroring settings.customOpenAIConfig
-- on the summary side. NULL means "not configured", in which case the app falls back
-- to the compile-time defaults in config.rs.
--
-- The summary blob cannot be reused: transcription and summarization run different
-- models on the same gateway, and save_custom_openai_config also rewrites
-- settings.provider as a side effect.
ALTER TABLE transcript_settings ADD COLUMN transcriptCustomConfig TEXT;
