import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { ChatMessage, ModelInvocation, ModelProvider, ModelResponse } from "./agent-loop.js";
import type { ToolRegistry } from "./tools.js";

export type TraceDirection = "CLIENT→CORE" | "CORE→CLIENT" | "CORE" | "CORE→LLM" | "LLM→CORE";
export type TraceLayer = "ipc" | "event" | "llm";
export type TraceRecord = {
  ts: string;
  direction: TraceDirection;
  layer: TraceLayer;
  kind: string;
  run_id?: string | null;
  step?: number | null;
  client_id?: string | null;
  data: Record<string, unknown>;
};

export class TraceWriter {
  private pending: Promise<void> = Promise.resolve();
  constructor(readonly filePath: string) {}

  emit(record: TraceRecord): void {
    const row = `${JSON.stringify(record)}\n`;
    this.pending = this.pending.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, row, "utf8");
    });
  }

  async flush(): Promise<void> { await this.pending; }
}

export class TracingProvider implements ModelProvider {
  constructor(private readonly inner: ModelProvider, private readonly trace: TraceWriter, private readonly includePayload = true) {}

  async complete(messages: ChatMessage[], tools: ToolRegistry, signal?: AbortSignal, onToken?: (token: string) => void, invocation?: ModelInvocation, onThinking?: (thinking: string) => void): Promise<ModelResponse> {
    const schemas = tools.list();
    this.trace.emit({
      ts: now(), direction: "CORE→LLM", layer: "llm", kind: "api_call",
      run_id: invocation?.runId ?? null, step: invocation?.step ?? null,
      data: this.includePayload ? { messages, tool_schemas: schemas } : { message_count: messages.length, tool_count: schemas.length },
    });
    const started = Date.now();
    try {
      const result = await this.inner.complete(messages, tools, signal, onToken, invocation, onThinking);
      this.trace.emit({
        ts: now(), direction: "LLM→CORE", layer: "llm", kind: "api_response",
        run_id: invocation?.runId ?? null, step: invocation?.step ?? null,
        data: this.includePayload
          ? { stop_reason: result.stop_reason, text: result.text, thinking_blocks: result.thinking_blocks ?? [], tool_calls: result.tool_calls, usage: result.usage ?? {}, model: result.model ?? "", latency_ms: Date.now() - started }
          : { stop_reason: result.stop_reason, usage: result.usage ?? {}, model: result.model ?? "", latency_ms: Date.now() - started },
      });
      return result;
    } catch (error) {
      this.trace.emit({
        ts: now(), direction: "LLM→CORE", layer: "llm", kind: "api_error",
        run_id: invocation?.runId ?? null, step: invocation?.step ?? null,
        data: { error: error instanceof Error ? error.message : String(error), latency_ms: Date.now() - started },
      });
      throw error;
    }
  }
}

const now = (): string => new Date().toISOString();
