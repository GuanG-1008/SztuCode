import type { ModelToolCall } from "./agent-loop.js";

export function stuckSignature(call: ModelToolCall): string {
  if (call.name === "bash") return `${call.name}:${String(call.input.command ?? "").trim()}`;
  for (const key of ["path", "file_path"]) if (key in call.input) return `${call.name}:${String(call.input[key])}`;
  return `${call.name}:${stableJson(call.input)}`;
}

export class StuckLoopTracker {
  private readonly consecutive = new Map<string, number>();
  private interventions = 0;

  constructor(private readonly maxFailures = 2, private readonly maxTotal = 0) {}

  recordFailure(signature: string): void { this.consecutive.set(signature, (this.consecutive.get(signature) ?? 0) + 1); }
  recordSuccess(signature: string): void { this.consecutive.set(signature, 0); }

  intervention(): { signature: string; consecutiveCount: number; totalInterventions: number; hardStop: boolean; message: string } | null {
    if (this.maxFailures <= 0) return null;
    const worst = [...this.consecutive].sort((left, right) => right[1] - left[1])[0];
    if (!worst || worst[1] < this.maxFailures) return null;
    const message = `Your previous tool call has failed repeatedly and appears to be stuck.\n  ${worst[0]} (${worst[1]} consecutive failures)\n\nChange your approach. Do not retry the same failing call; use different parameters, another tool, or re-plan the task.`;
    this.interventions += 1;
    this.consecutive.clear();
    return { signature: worst[0], consecutiveCount: worst[1], totalInterventions: this.interventions, hardStop: this.maxTotal > 0 && this.interventions >= this.maxTotal, message };
  }
}

const stableJson = (value: unknown): string => JSON.stringify(stableValue(value));

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stableValue(item)]));
  return value;
}
