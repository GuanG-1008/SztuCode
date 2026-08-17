import type { PermissionDecision, PermissionMode } from "@sztucode/protocol";
import { EventBus } from "./event-bus.js";
import type { ToolPermission } from "./tools-types.js";

type Pending = { resolve: (allowed: boolean) => void; runId: string };
export interface PermissionGate {
  check(runId: string, permissionId: string, toolName: string, params: Record<string, unknown>, permission: ToolPermission, signal?: AbortSignal): Promise<boolean>;
}
export class PermissionManager {
  private mode: PermissionMode = "normal";
  private readonly pending = new Map<string, Pending>();
  constructor(private readonly events: EventBus, private readonly timeoutMs = 60_000) {}
  getMode(): PermissionMode { return this.mode; }
  setMode(mode: PermissionMode): void { const old = this.mode; this.mode = mode; if (old !== mode) this.events.publish({ type: "permission.mode_changed", old_mode: old, new_mode: mode, ts: new Date().toISOString() }); }
  scoped(mode: PermissionMode): PermissionGate { return { check: (runId, permissionId, toolName, params, permission, signal) => this.checkWithMode(mode, runId, permissionId, toolName, params, permission, signal) }; }
  check(runId: string, permissionId: string, toolName: string, params: Record<string, unknown>, permission: ToolPermission, signal?: AbortSignal): Promise<boolean> {
    return this.checkWithMode(this.mode, runId, permissionId, toolName, params, permission, signal);
  }
  private checkWithMode(mode: PermissionMode, runId: string, permissionId: string, toolName: string, params: Record<string, unknown>, permission: ToolPermission, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false);
    if (toolName === "bash" && isDangerousCommand(String(params.command ?? ""))) return this.ask(runId, permissionId, toolName, params, signal);
    if (mode === "auto" || permission === "read_only" || (mode === "accept_edits" && permission === "workspace_write")) return Promise.resolve(true);
    if (mode === "plan") return Promise.resolve(false);
    return this.ask(runId, permissionId, toolName, params, signal);
  }
  private ask(runId: string, permissionId: string, toolName: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { if (this.pending.delete(permissionId)) resolve(false); }, this.timeoutMs);
      const finish = (allowed: boolean) => { clearTimeout(timer); signal?.removeEventListener("abort", abort); resolve(allowed); };
      const abort = () => { if (this.pending.delete(permissionId)) finish(false); };
      this.pending.set(permissionId, { resolve: finish, runId });
      signal?.addEventListener("abort", abort, { once: true });
      const paramPreview = preview(toolName, params);
      this.events.publish({ type: "permission.requested", run_id: runId, permission_id: permissionId, tool_use_id: permissionId, tool_name: toolName, params, preview: paramPreview, param_preview: paramPreview, ts: new Date().toISOString() });
    });
  }
  respond(permissionId: string, decision: PermissionDecision): boolean {
    const pending = this.pending.get(permissionId); if (!pending) return false;
    this.pending.delete(permissionId); const allowed = decision === "allow_once" || decision === "always_allow"; pending.resolve(allowed);
    const ts = new Date().toISOString();
    this.events.publish({ type: "permission.resolved", run_id: pending.runId, permission_id: permissionId, tool_use_id: permissionId, decision, ts });
    this.events.publish({ type: allowed ? "permission.granted" : "permission.denied", run_id: pending.runId, tool_use_id: permissionId, decision, ts }); return true;
  }
  cancelRun(runId: string): void {
    for (const [permissionId, pending] of this.pending) {
      if (pending.runId !== runId) continue;
      this.pending.delete(permissionId);
      pending.resolve(false);
    }
  }
}
const preview = (toolName: string, params: Record<string, unknown>): string => `${toolName}:${String(params[toolName === "bash" ? "command" : "path"] ?? "").slice(0, 120)}`;
const isDangerousCommand = (command: string): boolean => [
  /(^|\s)\//, /(^|\s)~/, /(^|\s)\.\.([/\\]|$)/, /\$\{?(HOME|PWD)\b/, /(^|[;&|])\s*(sudo|cd)\b/, /\bLD_(PRELOAD|LIBRARY_PATH)\b/
].some((pattern) => pattern.test(command));
