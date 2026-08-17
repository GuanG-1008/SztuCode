import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

export type ContentBlock = { type: string; text?: string; content?: string; [key: string]: unknown };
export type ContextToolCall = { id: string; name: string; input: Record<string, unknown> };
export type ContextMessage = { role: "system" | "user" | "assistant" | "tool"; content: string | ContentBlock[]; tool_call_id?: string; tool_calls?: ContextToolCall[] };
export type ContextCompactionProvider = { complete(messages: ContextMessage[], tools: { list(): unknown[] }, signal?: AbortSignal): Promise<{ text: string; usage?: { output_tokens?: number }; stop_reason?: string }> };
export type ContextCompactionResult = { originalTokens: number; summaryTokens: number; removedMessages: number; summaryText: string; usedModel: boolean };

const CJK_RANGES: Array<[number, number]> = [[0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xf900, 0xfaff], [0x20000, 0x2a6df]];
const isCjk = (char: string) => { const code = char.codePointAt(0) ?? 0; return CJK_RANGES.some(([low, high]) => code >= low && code <= high); };

export class TokenCounter {
  constructor(readonly encodingName = "fallback") {}
  count(text: string): number {
    if (!text) return 4;
    let cjk = 0;
    for (const char of text) if (isCjk(char)) cjk += 1;
    return Math.max(1, Math.ceil(cjk + (text.length - cjk) / 4) + 4);
  }
  countJson(value: unknown): number { return value === null || value === undefined || value === "" ? 0 : this.count(typeof value === "string" ? value : JSON.stringify(value)); }
  countMessages(messages: ContextMessage[]): number {
    return Math.max(1, messages.reduce((total, message) => total + (typeof message.content === "string" ? this.count(message.content) : message.content.reduce((sum, block) => sum + this.count(String(block.text ?? block.content ?? "")), 0)), 0));
  }
}

const OFFLOAD_MARKER = "[上下文卸载:";
const truncationMarker = (original: number, omitted: number, head: number, tail: number) => `\n[... original=${original} chars; ${omitted} chars omitted; kept=head:${head},tail:${tail} ...]\n`;

export function truncateText(text: string, budget: number, isError = false): string {
  if (text.length <= budget) return text;
  if (budget <= 0) return "";
  const ratio = isError ? 0.2 : 0.5;
  let retained = Math.min(text.length - 1, budget);
  let head = 0; let tail = 0; let marker = "";
  while (retained > 0) {
    head = Math.floor(retained * ratio); tail = retained - head;
    marker = truncationMarker(text.length, text.length - retained, head, tail);
    if (retained + marker.length <= budget) break;
    retained -= 1;
  }
  if (!retained) return truncationMarker(text.length, text.length, 0, 0).slice(0, budget);
  return text.slice(0, head) + marker + text.slice(text.length - tail);
}

export function truncateToolResults(messages: ContextMessage[], limit = 8_000, keep = 4_000): ContextMessage[] {
  const budget = Math.max(0, Math.min(limit, keep));
  return messages.map((message) => {
    if (message.role === "tool" && typeof message.content === "string" && message.content.length > limit && !message.content.includes(OFFLOAD_MARKER)) return { ...message, content: truncateText(message.content, budget) };
    if (message.role !== "user" || !Array.isArray(message.content)) return message;
    const content = message.content.map((block) => {
      if (block.type !== "tool_result" || typeof block.content !== "string" || block.content.includes(OFFLOAD_MARKER) || block.content.length <= limit) return block;
      return { ...block, content: truncateText(block.content, budget, block.is_error === true) };
    });
    return { ...message, content };
  });
}

export function sanitizeContextMessages(messages: ContextMessage[], toolResultLimit = 8_000): ContextMessage[] {
  const truncated = truncateToolResults(messages, toolResultLimit, Math.floor(toolResultLimit / 2));
  const pending = new Set<string>(); let lastBalanced = 0;
  truncated.forEach((message, index) => {
    if (message.role === "assistant") for (const call of message.tool_calls ?? []) pending.add(call.id);
    if (message.role === "tool" && message.tool_call_id) pending.delete(message.tool_call_id);
    if (!pending.size) lastBalanced = index + 1;
  });
  return pending.size ? truncated.slice(0, lastBalanced) : truncated;
}

function messagesToText(messages: ContextMessage[]): string {
  return messages.map((message) => {
    const content = typeof message.content === "string" ? message.content : message.content.map((block) => `${block.type}: ${String(block.text ?? block.content ?? "")}`).join("\n");
    const calls = message.tool_calls?.length ? `\nTool calls: ${message.tool_calls.map((call) => `${call.name}(${JSON.stringify(call.input)})`).join(", ")}` : "";
    return `[${message.role.toUpperCase()}]\n${content}${calls}`;
  }).join("\n\n");
}

export type ContextBudget = { maxTokens: number; reservedOutputTokens: number; maxToolResultChars: number };

export class ContextManager {
  readonly counter: TokenCounter;
  constructor(public messages: ContextMessage[] = [], private readonly budget: ContextBudget = { maxTokens: 128_000, reservedOutputTokens: 8_192, maxToolResultChars: 8_000 }, counter = new TokenCounter()) { this.counter = counter; }
  append(message: ContextMessage): void { this.messages.push(message); }
  tokenEstimate(): number { return this.counter.countMessages(this.messages); }
  availableTokens(): number { return Math.max(0, this.budget.maxTokens - this.budget.reservedOutputTokens - this.tokenEstimate()); }
  budgetMaxToolResultChars(): number { return this.budget.maxToolResultChars; }
  needsCompaction(): boolean { return this.tokenEstimate() + this.budget.reservedOutputTokens >= this.budget.maxTokens; }
  compact(slidingWindow = 8): ContextCompactionResult {
    const originalTokens = this.tokenEstimate();
    if (this.messages.length <= slidingWindow) return { originalTokens, summaryTokens: originalTokens, removedMessages: 0, summaryText: "", usedModel: false };
    const system = this.messages.filter((message) => message.role === "system");
    const recent = this.messages.slice(-slidingWindow).filter((message) => message.role !== "system");
    const removedMessages = this.messages.length - system.length - recent.length;
    this.messages = sanitizeContextMessages([...system, { role: "user", content: "[Earlier conversation compacted. Continue using the recent messages and current task state.]" }, ...recent], this.budget.maxToolResultChars);
    return { originalTokens, summaryTokens: this.tokenEstimate(), removedMessages, summaryText: "", usedModel: false };
  }
  async compactWithProvider(provider: ContextCompactionProvider, focus = "", slidingWindow = 8, signal?: AbortSignal): Promise<ContextCompactionResult> {
    const originalTokens = this.tokenEstimate();
    if (this.messages.length <= slidingWindow) return { originalTokens, summaryTokens: originalTokens, removedMessages: 0, summaryText: "", usedModel: false };
    const system = this.messages.filter((message) => message.role === "system");
    const nonSystem = this.messages.filter((message) => message.role !== "system");
    const recent = nonSystem.slice(-slidingWindow);
    const old = nonSystem.slice(0, -slidingWindow);
    const oldTokens = this.counter.countMessages(old);
    if (oldTokens < 64) return this.compact(slidingWindow);
    const prompt = [
      "Summarize the earlier agent conversation for continuation.",
      "Preserve the original goal, decisions, completed work, files and changes, failures, unresolved issues, and exact next steps.",
      "Be factual and compact. Do not invent information. Return plain text with headings: Goal, Progress, Decisions, Open Issues, Next Steps.",
      focus.trim() ? `Pay special attention to: ${focus.trim()}` : "",
      "\nEarlier messages:\n---\n" + messagesToText(old),
    ].filter(Boolean).join("\n");
    try {
      const response = await provider.complete([{ role: "user", content: prompt }], { list: () => [] }, signal);
      const summaryText = response.text.trim();
      const summaryTokens = Number(response.usage?.output_tokens ?? this.counter.count(summaryText));
      const valid = summaryText.length >= 40 && summaryTokens > 0 && summaryTokens < oldTokens && /goal|progress|next steps|open issues|decisions/i.test(summaryText);
      if (valid) {
        const continuation = `This session continues from an earlier context. Use this summary as authoritative context and continue directly.\n\n${summaryText}`;
        this.messages = sanitizeContextMessages([...system, { role: "user", content: continuation }, { role: "assistant", content: "Understood. Continuing from the summary." }, ...recent], this.budget.maxToolResultChars);
        return { originalTokens, summaryTokens: this.tokenEstimate(), removedMessages: old.length, summaryText, usedModel: true };
      }
    } catch { /* deterministic fallback below */ }
    return this.compact(slidingWindow);
  }
  async save(filePath: string): Promise<void> { await mkdir(path.dirname(filePath), { recursive: true }); await writeFile(filePath, `${JSON.stringify(this.messages)}\n`, "utf8"); }
  static async load(filePath: string): Promise<ContextManager> { try { return new ContextManager(JSON.parse(await readFile(filePath, "utf8")) as ContextMessage[]); } catch { return new ContextManager(); } }
}
