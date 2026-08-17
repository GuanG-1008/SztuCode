import type { ChatMessage, ModelProvider, ModelResponse } from "../agent-loop.js";
import type { ToolRegistry } from "../tools.js";

type AnthropicResponse = { content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>; stop_reason?: string; usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } };
export type AnthropicProviderOptions = { apiKey: string; baseUrl?: string; model: string; maxTokens?: number; timeoutMs?: number; temperature?: number | null; topP?: number | null; reasoningEffort?: string; cacheControl?: boolean };

export class AnthropicMessagesProvider implements ModelProvider {
  constructor(private readonly options: AnthropicProviderOptions) {}
  async complete(messages: ChatMessage[], tools: ToolRegistry, signal?: AbortSignal, onToken?: (token: string) => void): Promise<ModelResponse> {
    const system = messages.filter((message) => message.role === "system").map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n");
    const bodyMessages = messages.filter((message) => message.role !== "system").map((message) => {
      if (message.role === "assistant" && message.tool_calls?.length) return { role: "assistant", content: [...(typeof message.content === "string" && message.content ? [{ type: "text", text: message.content }] : []), ...message.tool_calls.map((call) => ({ type: "tool_use", id: call.id, name: call.name, input: call.input }))] };
      if (message.role === "tool") return { role: "user", content: [{ type: "tool_result", tool_use_id: message.tool_call_id ?? "", content: typeof message.content === "string" ? message.content : JSON.stringify(message.content) }] };
      return { role: message.role, content: typeof message.content === "string" ? message.content : message.content };
    });
    const controller = new AbortController(); const abort = () => controller.abort(signal?.reason); signal?.addEventListener("abort", abort, { once: true }); const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 120_000);
    try {
      const systemValue = this.options.cacheControl && system ? [{ type: "text", text: system, cache_control: { type: "ephemeral" } }] : system ? system : undefined;
      const streaming = Boolean(onToken);
      const response = await fetch(`${(this.options.baseUrl ?? "https://api.anthropic.com/v1").replace(/\/$/, "")}/messages`, { method: "POST", headers: { "x-api-key": this.options.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json", ...(streaming ? { accept: "text/event-stream" } : {}) }, body: JSON.stringify({ model: this.options.model, max_tokens: this.options.maxTokens ?? 8192, stream: streaming, ...(systemValue ? { system: systemValue } : {}), messages: bodyMessages, tools: tools.list().map((tool, index, all) => ({ name: tool.name, description: tool.description, input_schema: tool.schema, ...(this.options.cacheControl && index === all.length - 1 ? { cache_control: { type: "ephemeral" } } : {}) })), ...(this.options.temperature != null ? { temperature: this.options.temperature } : {}), ...(this.options.topP != null ? { top_p: this.options.topP } : {}), ...(this.options.reasoningEffort ? { thinking: { type: "adaptive" }, output_config: { effort: this.options.reasoningEffort } } : {}) }), signal: controller.signal });
      if (!response.ok) throw new Error(`Anthropic request failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
      if (streaming && response.body) return await parseAnthropicStream(response.body, this.options.model, onToken);
      const data = await response.json() as AnthropicResponse; const content = data.content ?? []; const text = content.filter((block) => block.type === "text").map((block) => block.text ?? "").join(""); const calls = content.filter((block) => block.type === "tool_use" && block.id && block.name).map((block) => ({ id: block.id!, name: block.name!, input: block.input ?? {} }));
      if (text) onToken?.(text);
      return { text, tool_calls: calls, stop_reason: calls.length ? "tool_use" : "end_turn", model: this.options.model, streamed: Boolean(onToken), usage: { input_tokens: Number(data.usage?.input_tokens ?? 0), output_tokens: Number(data.usage?.output_tokens ?? 0), cache_read_input_tokens: Number(data.usage?.cache_read_input_tokens ?? 0), cache_creation_input_tokens: Number(data.usage?.cache_creation_input_tokens ?? 0) } };
    } finally { clearTimeout(timeout); signal?.removeEventListener("abort", abort); }
  }
}

type AnthropicStreamState = { text: string; stopReason: string; calls: Map<number, { id: string; name: string; inputJson: string }>; usage: ModelResponse["usage"] };

async function parseAnthropicStream(body: ReadableStream<Uint8Array>, model: string, onToken?: (token: string) => void): Promise<ModelResponse> {
  const decoder = new TextDecoder();
  const state: AnthropicStreamState = { text: "", stopReason: "end_turn", calls: new Map(), usage: {} };
  let buffer = "";
  const consume = (event: string, data: string) => {
    if (!data || data === "[DONE]") return;
    let payload: any;
    try { payload = JSON.parse(data); } catch { return; }
    if (event === "message_start") {
      state.usage = { ...state.usage, input_tokens: Number(payload.message?.usage?.input_tokens ?? 0), cache_read_input_tokens: Number(payload.message?.usage?.cache_read_input_tokens ?? 0), cache_creation_input_tokens: Number(payload.message?.usage?.cache_creation_input_tokens ?? 0) };
    } else if (event === "content_block_start" && payload.content_block?.type === "tool_use") {
      const initialInput = payload.content_block.input;
      state.calls.set(Number(payload.index ?? state.calls.size), { id: String(payload.content_block.id ?? ""), name: String(payload.content_block.name ?? ""), inputJson: initialInput && Object.keys(initialInput).length ? JSON.stringify(initialInput) : "" });
    } else if (event === "content_block_delta") {
      const delta = payload.delta ?? {};
      if (delta.type === "text_delta" && typeof delta.text === "string") { state.text += delta.text; onToken?.(delta.text); }
      if (delta.type === "input_json_delta") { const call = state.calls.get(Number(payload.index)); if (call) call.inputJson += String(delta.partial_json ?? ""); }
    } else if (event === "message_delta") {
      state.stopReason = String(payload.delta?.stop_reason ?? state.stopReason);
      state.usage = { ...state.usage, output_tokens: Number(payload.usage?.output_tokens ?? state.usage?.output_tokens ?? 0) };
    }
  };
  const flush = (final: boolean) => {
    buffer = buffer.replace(/\r\n/g, "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
      let event = "message"; let data = "";
      for (const line of frame.split(/\r?\n/)) { if (line.startsWith("event:")) event = line.slice(6).trim(); else if (line.startsWith("data:")) data += line.slice(5).trim(); }
      consume(event, data); boundary = buffer.indexOf("\n\n");
    }
    if (final && buffer.trim()) { const frame = buffer.trim(); buffer = ""; let event = "message"; let data = ""; for (const line of frame.split(/\r?\n/)) { if (line.startsWith("event:")) event = line.slice(6).trim(); else if (line.startsWith("data:")) data += line.slice(5).trim(); } consume(event, data); }
  };
  for await (const chunk of body) { buffer += decoder.decode(chunk, { stream: true }); flush(false); }
  buffer += decoder.decode(); flush(true);
  const tool_calls = [...state.calls.values()].filter((call) => call.id && call.name).map((call) => { let input: Record<string, unknown> = {}; try { input = JSON.parse(call.inputJson || "{}"); } catch { input = {}; } return { id: call.id, name: call.name, input }; });
  return { text: state.text, tool_calls, stop_reason: tool_calls.length || state.stopReason === "tool_use" ? "tool_use" : "end_turn", model, streamed: true, usage: state.usage };
}
