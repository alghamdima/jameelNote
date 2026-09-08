# Files

- [llama-helper Sidecar](llama-helper-sidecar.md) - The standalone llama-cpp-2 sidecar crate behind BuiltInAI summaries — line-delimited JSON protocol over stdin/stdout, supervised process lifecycle (keep-alive, health pings, idle timeout, graceful shutdown), GGUF model catalog and downloads, and build/bundle wiring.
- [LLM Provider Integrations](llm-providers.md) - Every summary-model backend in Meetily — Ollama, Claude, Groq, OpenAI, OpenRouter, custom OpenAI-compatible endpoints, and the local BuiltInAI sidecar — covering provider parsing, settings persistence and API-key columns, per-provider model discovery, request/response shapes, timeouts, and cancellation.
