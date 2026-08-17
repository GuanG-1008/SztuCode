import type { RuntimeEvent } from "@sztucode/protocol";
import { appendFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";

export type EventListener = (event: RuntimeEvent) => void;

export class EventBus {
  private readonly listeners = new Set<EventListener>();
  private readonly history: RuntimeEvent[] = [];
  constructor(private readonly tracePath = path.join(process.env.SZTU_DATA_DIR ?? path.join(process.env.USERPROFILE ?? process.cwd(), ".sztu"), "traces", "runtime-ts-events.jsonl")) {
    try {
      const rows = readFileSync(this.tracePath, "utf8").split(/\r?\n/).filter(Boolean).slice(-10_000);
      for (const row of rows) {
        try { this.history.push(JSON.parse(row) as RuntimeEvent); } catch { /* ignore a partial final row */ }
      }
    } catch { /* first start has no trace */ }
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event: RuntimeEvent): void {
    this.history.push(event);
    if (this.history.length > 10_000) this.history.splice(0, this.history.length - 10_000);
    void mkdir(path.dirname(this.tracePath), { recursive: true }).then(() => appendFile(this.tracePath, `${JSON.stringify(event)}\n`, "utf8")).catch(() => undefined);
    for (const listener of this.listeners) listener(event);
  }

  replay(maxEvents = 2_000): RuntimeEvent[] {
    return this.history.slice(-Math.max(1, Math.min(maxEvents, 10_000)));
  }
  replayRun(runId: string, maxEvents = 2_000): RuntimeEvent[] {
    return this.history.filter((event) => "run_id" in event && event.run_id === runId).slice(-Math.max(1, Math.min(maxEvents, 10_000)));
  }
}
