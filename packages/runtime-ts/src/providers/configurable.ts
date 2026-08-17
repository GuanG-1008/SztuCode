import type { ChatMessage, ModelProvider, ModelResponse } from "../agent-loop.js";
import type { ToolRegistry } from "../tools.js";
import { SettingsStore } from "../settings.js";
import { AnthropicMessagesProvider } from "./anthropic.js";
import { OpenAiCompatibleProvider } from "./openai.js";

export class ConfigurableProvider implements ModelProvider {
  constructor(private readonly settings: SettingsStore) {}
  async complete(messages: ChatMessage[], tools: ToolRegistry, signal?: AbortSignal, onToken?: (token: string) => void): Promise<ModelResponse> {
    const config = await this.settings.getProviderConfig();
    const completeOnce = async () => {
      if (config.provider === "anthropic" || config.api_format === "anthropic_messages") {
        const apiKey = config.api_key ?? process.env.ANTHROPIC_API_KEY;
        if (!apiKey) throw new Error("Anthropic API key is not configured");
        return new AnthropicMessagesProvider({ apiKey, baseUrl: config.base_url || process.env.ANTHROPIC_BASE_URL, model: config.model, maxTokens: config.max_output_tokens, timeoutMs: config.timeout_s * 1000, temperature: config.temperature, topP: config.top_p, reasoningEffort: config.reasoning_effort, cacheControl: config.cache_control }).complete(messages, tools, signal, onToken);
      }
      const apiKey = config.keyless ? undefined : config.api_key ?? process.env.OPENAI_API_KEY ?? process.env.DEEPSEEK_API_KEY;
      if (!config.keyless && !apiKey) throw new Error("OpenAI-compatible API key is not configured");
      return new OpenAiCompatibleProvider({ apiKey, baseUrl: config.base_url || (process.env.OPENAI_BASE_URL ?? process.env.DEEPSEEK_BASE_URL), model: config.model, apiFormat: config.api_format, maxOutputTokens: config.max_output_tokens, temperature: config.temperature, topP: config.top_p, reasoningEffort: config.reasoning_effort, timeoutMs: config.timeout_s * 1000, stream: true }).complete(messages, tools, signal, onToken);
    };
    let lastError: unknown;
    for (let attempt = 0; attempt <= Math.max(0, Math.min(10, config.max_retries)); attempt += 1) {
      try { return await completeOnce(); } catch (error) { lastError = error; if (signal?.aborted || attempt >= config.max_retries || !isRetryable(error)) throw error; await new Promise((resolve) => setTimeout(resolve, Math.min(2_000, 200 * 2 ** attempt))); }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

function isRetryable(error: unknown): boolean { const message = error instanceof Error ? error.message : String(error); return /\b(429|500|502|503|504)\b|timeout|aborted|fetch failed|network|socket|ECONN|ETIMEDOUT/i.test(message); }
