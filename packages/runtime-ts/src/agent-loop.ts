import type { RuntimeEvent } from "@sztucode/protocol";
import { EventBus } from "./event-bus.js";
import { ToolRegistry, type ToolContext } from "./tools.js";
import type { PermissionGate } from "./permissions.js";
import { ContextManager, sanitizeContextMessages, type ContextMessage } from "./context.js";
import { DenialTracker } from "./denial-tracker.js";
import { StuckLoopTracker, stuckSignature } from "./stuck-tracker.js";
import path from "node:path";
import { createReadRefTool, OffloadManager } from "./offload.js";
import { validateSchema } from "./schema-validator.js";

export type ChatMessage = ContextMessage;
export type ModelToolCall = { id: string; name: string; input: Record<string, unknown> };
export type ModelUsage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number };
export type ModelResponse = { text: string; tool_calls: ModelToolCall[]; stop_reason: "end_turn" | "tool_use"; usage?: Partial<ModelUsage>; model?: string; streamed?: boolean };
export interface ModelProvider { complete(messages: ChatMessage[], tools: ToolRegistry, signal?: AbortSignal, onToken?: (token: string) => void): Promise<ModelResponse> }
export type AgentLoopOptions = { contextWindow?: number; maxOutputTokens?: number; sessionId?: string; streaming?: boolean; stuckMaxFailures?: number; stuckMaxTotal?: number; offloadEnabled?: boolean; offloadMinChars?: number; offloadMinLines?: number; offloadRoot?: string };

export class EchoProvider implements ModelProvider {
  async complete(messages: ChatMessage[]): Promise<ModelResponse> {
    const last = messages.at(-1)?.content ?? "";
    return { text: `TypeScript agent: ${last}`, tool_calls: [], stop_reason: "end_turn" };
  }
}

export class AgentLoop {
  constructor(private readonly provider: ModelProvider, private readonly tools: ToolRegistry, private readonly context: ToolContext, private readonly events: EventBus, private readonly permissions: PermissionGate, private readonly options: AgentLoopOptions = {}) {}

  async run(runId: string, goal: string, maxSteps = 20, history: ChatMessage[] = [], signal?: AbortSignal, takeSteering?: () => ChatMessage[]): Promise<{ text: string; steps: number; messages: ChatMessage[]; usage: ModelUsage }> {
    const offload = new OffloadManager(this.options.offloadRoot ?? path.join(dataRoot(), "runs", safeRunId(runId)), { enabled: this.options.offloadEnabled ?? booleanEnv("SZTU_OFFLOAD_ENABLED", true), minChars: this.options.offloadMinChars ?? nonNegativeEnv("SZTU_OFFLOAD_MIN_CHARS", 2_000), minLines: this.options.offloadMinLines ?? nonNegativeEnv("SZTU_OFFLOAD_MIN_LINES", 50) });
    this.tools.replace(createReadRefTool(offload));
    const context = new ContextManager([...history, { role: "user", content: goal }], { maxTokens: this.options.contextWindow ?? 128_000, reservedOutputTokens: this.options.maxOutputTokens ?? 8_192, maxToolResultChars: 8_000 });
    const messages = context.messages;
    const initialSystem = messages.find((message) => message.role === "system");
    if (initialSystem) { const text = typeof initialSystem.content === "string" ? initialSystem.content : JSON.stringify(initialSystem.content); this.publish({ type: "context.injected", run_id: runId, source: "system", label: "上下文注入", chars: text.length, preview: text.slice(0, 160), text, ts: now() }); }
    const usage: ModelUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    const denials = new DenialTracker();
    const stuck = new StuckLoopTracker(this.options.stuckMaxFailures ?? nonNegativeEnv("SZTU_STUCK_MAX_FAILURES", 2), this.options.stuckMaxTotal ?? nonNegativeEnv("SZTU_STUCK_MAX_TOTAL", 0));
    for (let step = 1; step <= maxSteps; step += 1) {
      signal?.throwIfAborted();
      if (context.needsCompaction()) {
        if (this.options.sessionId) this.publish({ type: "context.compacting", session_id: this.options.sessionId, run_id: runId, ts: now() });
        const result = await context.compactWithProvider(this.provider, "", 8, signal);
        this.publish({ type: "log.line", run_id: runId, level: "INFO", source: "context", message: `${result.usedModel ? "Summarized" : "Compacted"} ${result.removedMessages} messages`, ts: now() });
        if (this.options.sessionId) this.publish({ type: "context.compacted", session_id: this.options.sessionId, run_id: runId, original_tokens: result.originalTokens, summary_tokens: result.summaryTokens, ts: now() });
      }
      this.publish({ type: "step.started", run_id: runId, step, ts: now() });
      const intervention = denials.intervention();
      if (intervention) {
        messages.push({ role: "user", content: intervention.message });
        this.publish({ type: "denial.intervention", run_id: runId, tool_name: intervention.toolName, consecutive_count: intervention.consecutiveCount, total_denials: intervention.totalDenials, message: intervention.message, ts: now() });
      }
      const stuckIntervention = stuck.intervention();
      if (stuckIntervention) {
        messages.push({ role: "user", content: stuckIntervention.message });
        this.publish({ type: "stuck.loop", run_id: runId, signature: stuckIntervention.signature, consecutive_count: stuckIntervention.consecutiveCount, total_interventions: stuckIntervention.totalInterventions, message: stuckIntervention.message, ts: now() });
        if (stuckIntervention.hardStop) throw new Error(`Agent stopped after ${stuckIntervention.totalInterventions} stuck-loop intervention(s)`);
      }
      const steering = takeSteering?.() ?? [];
      if (steering.length) {
        messages.push(...steering);
        this.publish({ type: "log.line", run_id: runId, level: "INFO", source: "session", message: `Injected ${steering.length} steering message(s)`, ts: now() });
      }
      const sanitized = sanitizeContextMessages(messages, context.budgetMaxToolResultChars());
      if (sanitized.length !== messages.length || sanitized.some((message, index) => message !== messages[index])) { messages.splice(0, messages.length, ...sanitized); }
      const response = await this.provider.complete(messages, this.tools, signal, (token) => this.publish({ type: "llm.token", run_id: runId, token, ts: now() }));
      usage.input_tokens += Number(response.usage?.input_tokens ?? 0);
      usage.output_tokens += Number(response.usage?.output_tokens ?? 0);
      usage.cache_read_input_tokens += Number(response.usage?.cache_read_input_tokens ?? 0);
      usage.cache_creation_input_tokens += Number(response.usage?.cache_creation_input_tokens ?? 0);
      const contextWindow = this.options.contextWindow ?? 128_000;
      const reservedOutputTokens = this.options.maxOutputTokens ?? 8_192;
      this.publish({ type: "llm.usage", run_id: runId, input_tokens: Number(response.usage?.input_tokens ?? 0), output_tokens: Number(response.usage?.output_tokens ?? 0), cache_read_input_tokens: Number(response.usage?.cache_read_input_tokens ?? 0), cache_creation_input_tokens: Number(response.usage?.cache_creation_input_tokens ?? 0), context_pct: Math.min(1, context.tokenEstimate() / Math.max(1, contextWindow)), model: response.model ?? "", context_window: contextWindow, available_tokens: context.availableTokens(), reserved_output_tokens: reservedOutputTokens, system_tokens: messages.filter((message) => message.role === "system").reduce((sum, message) => sum + context.counter.countJson(message.content), 0), summary_tokens: 0, conversation_tokens: context.counter.countMessages(messages), tool_tokens: messages.filter((message) => message.role === "tool").reduce((sum, message) => sum + context.counter.countJson(message.content), 0), ts: now() });
      if (response.text && (!this.options.streaming || !response.streamed)) this.publish({ type: "llm.token", run_id: runId, token: response.text, ts: now() });
      if (response.stop_reason === "end_turn" || response.tool_calls.length === 0) {
        this.publish({ type: "step.finished", run_id: runId, step, ts: now() });
        messages.push({ role: "assistant", content: response.text });
        return { text: response.text, steps: step, messages, usage };
      }
      messages.push({ role: "assistant", content: response.text, tool_calls: response.tool_calls });
      for (const call of response.tool_calls) {
        signal?.throwIfAborted();
        const tool = this.tools.get(call.name);
        this.publish({ type: "tool.call_started", run_id: runId, tool_use_id: call.id, tool_name: call.name, params: call.input, ts: now() });
        if (!tool) {
          stuck.recordFailure(stuckSignature(call));
          this.publish({ type: "tool.call_failed", run_id: runId, tool_use_id: call.id, tool_name: call.name, error_class: "unknown_tool", error_message: `Unknown tool: ${call.name}`, elapsed_ms: 0, ts: now() });
          messages.push({ role: "tool", tool_call_id: call.id, content: `Unknown tool: ${call.name}` });
          continue;
        }
        const validation = validateSchema(call.input, tool.schema);
        if (!validation.valid) {
          stuck.recordFailure(stuckSignature(call));
          this.publish({ type: "tool.call_failed", run_id: runId, tool_use_id: call.id, tool_name: call.name, error_class: "schema_error", error_message: validation.error, elapsed_ms: 0, ts: now() });
          messages.push({ role: "tool", tool_call_id: call.id, content: validation.error });
          continue;
        }
        const allowed = await this.permissions.check(runId, call.id, call.name, call.input, tool.permission, signal);
        if (!allowed) {
          denials.recordDenial(call.name);
          this.publish({ type: "tool.call_failed", run_id: runId, tool_use_id: call.id, tool_name: call.name, error_class: "permission_denied", error_message: "Permission denied or approval timed out", elapsed_ms: 0, ts: now() });
          messages.push({ role: "tool", tool_call_id: call.id, content: "Permission denied" });
          continue;
        }
        const started = Date.now();
        const result = await tool.invoke(call.input, { ...this.context, signal });
        const elapsedMs = Date.now() - started;
        const rawOutput = result.ok ? result.output : [result.output, result.error].filter(Boolean).join("\n") || "Tool failed";
        let contextOutput = rawOutput;
        if (offload.shouldOffload(call.name, rawOutput)) {
          try { contextOutput = offload.placeholder(await offload.offload(call.name, call.id, rawOutput, runId, !result.ok)); } catch { /* Context truncation remains the fallback. */ }
        }
        if (result.ok) {
          denials.recordSuccess(call.name);
          stuck.recordSuccess(stuckSignature(call));
          this.publish({ type: "tool.call_finished", run_id: runId, tool_use_id: call.id, tool_name: call.name, elapsed_ms: elapsedMs, output: contextOutput, ts: now() });
          if (isTestCommand(String(call.input.command ?? ""))) this.publish({ type: "test.result", run_id: runId, tool_use_id: call.id, status: "passed", summary: testSummary(String(call.input.command ?? ""), result.output), ts: now() });
        }
        else { stuck.recordFailure(stuckSignature(call)); this.publish({ type: "tool.call_failed", run_id: runId, tool_use_id: call.id, tool_name: call.name, error_class: result.errorType ?? "runtime_error", error_message: result.error ?? "Tool failed", elapsed_ms: elapsedMs, ts: now() }); if (isTestCommand(String(call.input.command ?? ""))) this.publish({ type: "test.result", run_id: runId, tool_use_id: call.id, status: "failed", summary: testSummary(String(call.input.command ?? ""), result.error ?? "Tool failed"), ts: now() }); }
        messages.push({ role: "tool", tool_call_id: call.id, content: contextOutput });
      }
      this.publish({ type: "step.finished", run_id: runId, step, ts: now() });
    }
    throw new Error(`Agent exceeded max steps (${maxSteps})`);
  }

  private publish(event: RuntimeEvent): void { this.events.publish(event); }
}

const now = () => new Date().toISOString();
const nonNegativeEnv = (name: string, fallback: number): number => { const value = Number(process.env[name]); return Number.isInteger(value) && value >= 0 ? value : fallback; };
const booleanEnv = (name: string, fallback: boolean): boolean => process.env[name] === undefined ? fallback : !/^(0|false|no)$/i.test(process.env[name] ?? "");
const dataRoot = () => process.env.SZTU_DATA_DIR ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? process.cwd(), ".sztu");
const safeRunId = (runId: string) => runId.replace(/[^A-Za-z0-9_.-]/g, "_") || "run";
const isTestCommand = (command: string): boolean => /(^|\s)(pytest|vitest|jest|npm\s+test|pnpm\s+test|yarn\s+test|cargo\s+test)(\s|$)/i.test(command);
const testSummary = (command: string, output: string): string => { const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean); const relevant = lines.filter((line) => /passed|failed|error|test/i.test(line)); return (relevant.at(-1) ?? lines.at(-1) ?? command).slice(0, 300); };
