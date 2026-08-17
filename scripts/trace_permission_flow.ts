import { IpcClient } from "../packages/cli/src/client.js";
import type { RuntimeEvent } from "@sztucode/protocol";

const goal = "用 bash 执行 `echo hello_permission_test`，把结果告诉我";
const timeoutMs = 60_000;

const brief = (event: RuntimeEvent): string => {
  const ignored = new Set(["type", "ts", "run_id", "session_id"]);
  const values = Object.entries(event).filter(([key]) => !ignored.has(key)).map(([key, value]) => `${key}=${JSON.stringify(value)}`);
  const text = values.join("  ");
  return text.length > 120 ? `${text.slice(0, 120)}...` : text;
};

async function main(): Promise<void> {
  const events: RuntimeEvent[] = [];
  let finished: (() => void) | undefined;
  const done = new Promise<void>((resolve) => { finished = resolve; });
  let permissionSeen = false;
  const client = new IpcClient(undefined, undefined, (event) => {
    events.push(event);
    console.log(`  [event] ${event.type.padEnd(35)} ${brief(event)}`);
    if (event.type === "permission.requested") {
      permissionSeen = true;
      void client.request("permission.respond", { permission_id: event.permission_id, decision: "allow_once" });
    }
    if (event.type === "run.finished") finished?.();
  });

  console.log(`[connect] ${client.host}:${client.port}`);
  await client.connect();
  try {
    await client.request("event.subscribe", { topics: ["session.*", "run.*", "step.*", "tool.*", "llm.*", "log.*", "permission.*"], scope: "global" });
    const session = await client.request("session.create", { mode: "chat" });
    const sessionId = String(session.session_id);
    console.log(`[session] ${sessionId}`);
    console.log(`[send] ${goal}`);
    await client.request("session.send_message", { session_id: sessionId, content: goal, client_message_id: `permission-trace-${Date.now()}` });
    await Promise.race([done, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("run timed out after 60s")), timeoutMs))]);
    const counts = new Map<string, number>();
    for (const event of events) counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
    console.log("\nSummary:");
    for (const [type, count] of counts) console.log(`  ${type.padEnd(35)} x${count}`);
    if (!permissionSeen) throw new Error("permission.requested was not observed");
    console.log("[ok] permission.requested was observed and approved");
    await client.request("session.close", { session_id: sessionId }).catch(() => undefined);
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error(`[error] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
