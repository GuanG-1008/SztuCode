export class DenialTracker {
  private readonly consecutive = new Map<string, number>();
  private total = 0;
  private intervenedThisCycle = false;

  constructor(private readonly maxConsecutive = 3, private readonly maxTotal = 20) {}

  recordDenial(toolName: string): void {
    this.consecutive.set(toolName, (this.consecutive.get(toolName) ?? 0) + 1);
    this.total += 1;
  }

  recordSuccess(toolName: string): void {
    this.consecutive.set(toolName, 0);
    this.intervenedThisCycle = false;
  }

  intervention(): { toolName: string; consecutiveCount: number; totalDenials: number; message: string } | null {
    const worst = [...this.consecutive].sort((left, right) => right[1] - left[1])[0];
    if ((!worst || worst[1] < this.maxConsecutive) && (this.total < this.maxTotal || this.intervenedThisCycle)) return null;
    const denied = [...this.consecutive].filter(([, count]) => count > 0).sort((left, right) => right[1] - left[1]);
    const message = `Your previous tool calls have been repeatedly rejected.\n${denied.map(([name, count]) => `  ${name} (${count} time${count === 1 ? "" : "s"})`).join("\n")}\n\nChange your approach: use a different tool, modify the parameters, or ask the user for guidance.`;
    const result = { toolName: worst?.[0] ?? "unknown", consecutiveCount: worst?.[1] ?? 0, totalDenials: this.total, message };
    this.consecutive.clear();
    this.intervenedThisCycle = true;
    return result;
  }
}
