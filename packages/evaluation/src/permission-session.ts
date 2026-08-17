import net from "node:net";
import { randomUUID } from "node:crypto";

export type PermissionMode = "normal" | "plan" | "accept_edits" | "auto";

export function parsePermissionMode(args: string[], enforceAuto = true): PermissionMode {
  const index = args.indexOf("--permission-mode");
  const value = index >= 0 ? args[index + 1] : "accept_edits";
  if (!( ["normal", "plan", "accept_edits", "auto"] as string[]).includes(value)) throw new Error(`invalid permission mode: ${value}`);
  if (enforceAuto && value === "auto" && !args.includes("--allow-auto-permissions")) throw new Error("auto permission mode requires --allow-auto-permissions");
  return value as PermissionMode;
}

export async function withDaemonPermission<T>(host: string, port: number, timeoutSeconds: number, mode: PermissionMode, operation: () => Promise<T>): Promise<T> {
  const socket = net.createConnection({ host, port });
  let buffer = "";
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  const failPending = (error: Error) => { for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); } pending.clear(); };
  const send = (method: string, params: Record<string, unknown>) => new Promise<any>((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => { if (pending.delete(id)) reject(new Error(`RPC timeout: ${method}`)); }, timeoutSeconds * 1000);
    pending.set(id, { resolve, reject, timer });
    socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); index = buffer.indexOf("\n");
      try {
        const message = JSON.parse(line);
        const request = pending.get(message.id);
        if (!request) continue;
        pending.delete(message.id); clearTimeout(request.timer);
        request.resolve(message.error ? { __error: message.error } : message.result);
      } catch { /* ignore malformed side-channel data */ }
    }
  });
  socket.on("error", (error) => failPending(error));
  let original: PermissionMode | undefined;
  let changed = false;
  try {
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    const settings = await send("settings.get", {});
    if (settings.__error) throw new Error(String(settings.__error.message ?? "settings.get failed"));
    const candidate = settings.settings?.permission_mode;
    if (["normal", "plan", "accept_edits", "auto"].includes(candidate)) original = candidate as PermissionMode;
    if (!original) throw new Error("daemon returned an invalid permission mode");
    if (original !== mode) {
      const result = await send("permission.set_mode", { mode });
      if (result.__error) throw new Error(String(result.__error.message ?? "permission.set_mode failed"));
      changed = true;
    }
    return await operation();
  } finally {
    if (changed && original && !socket.destroyed) await send("permission.set_mode", { mode: original }).catch(() => undefined);
    failPending(new Error("permission session closed"));
    socket.destroy();
  }
}
