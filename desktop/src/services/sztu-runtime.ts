import { invoke } from "@tauri-apps/api/core";
import { IpcClient } from "../lib/ipc";

export type Workspace = { workspace_id: string; name: string; path: string; archived: boolean };
export type NativeSettings = { autostart: boolean; stay_awake: boolean; supported: boolean };
export type WorkspaceNode = { path: string; name: string; kind: "directory" | "file"; children?: WorkspaceNode[] };
export type FileSearchMatch = { path: string; line: number; preview: string };
export type FileReadResult = {
  content: string; encoding: string; binary: boolean; truncated: boolean;
  media_base64?: string | null; mime_type?: string | null;
};
// 「添加附件」读取结果：图片/二进制给 data_base64，文本给 text_content，超限/失败给 error
export type Attachment = {
  path: string; name: string; size: number;
  mime_type?: string | null; is_text: boolean;
  text_content?: string | null; data_base64?: string | null; error?: string | null;
};
// 随消息发送的图片内容块，字段与 daemon 的 MessageImageBlock 对齐
export type ImageBlock = { media_type: string; data: string };
export type ChangeSummary = {
  path: string; index_status: string; worktree_status: string;
  run_id?: string | null; agent_owned?: boolean; revertible?: boolean;
  additions?: number; deletions?: number;
};
export type Session = {
  session_id: string; title: string; status: string; updated_at: string;
  archived: boolean; pinned: boolean; workspace_id: string | null; latest_run_id?: string | null;
  total_input_tokens: number; total_output_tokens: number; total_elapsed_s: number;
};
export type RunStats = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; elapsed_s: number };
export type SessionHistory = { messages: unknown[]; run_stats: Record<string, RunStats> };
export type RuntimeSettings = { provider: "anthropic" | "openai"; model: string; permission_mode: "normal" | "accept_edits" | "plan" | "auto"; base_url?: string };
export type RuntimeSettingsUpdate = Partial<RuntimeSettings> & { api_key?: string };
export type ProviderStatus = { api_key_configured: boolean; ready_for_next_run: boolean; skills: Array<{ name: string; description: string }>; mcp_servers: Array<{ name: string; status: string; tool_count?: number }> };
export type ModelProfile = { id: string; name: string; vendor: string; provider: "anthropic" | "openai"; model: string; base_url: string; has_api_key: boolean; is_current: boolean; builtin: boolean };
export type ModelProfileInput = { id?: string; name: string; vendor: string; provider: "anthropic" | "openai"; model: string; base_url: string; api_key?: string };

const client = new IpcClient();
let subscribed = false;
client.onDisconnect(() => { subscribed = false; });
const EVENT_TOPICS = [
  "session.*", "run.*", "step.*", "llm.*", "tool.*", "permission.*",
  "plan.*", "test.*", "change.*", "log.*", "subagent.*", "skill.*", "context.*", "denial.*",
];

async function waitForDaemon(): Promise<void> {
  try {
    await invoke("daemon_start");
  } catch {
    // Browser-based UI tests have no Tauri host. The connection attempt below
    // remains the source of truth for runtime availability.
  }
}

export async function getNativeSettings(): Promise<NativeSettings> {
  return await invoke<NativeSettings>("native_settings_get");
}

export async function setNativeSettings(update: { autostart?: boolean; stayAwake?: boolean }): Promise<NativeSettings> {
  return await invoke<NativeSettings>("native_settings_update", update);
}

export async function sandboxPtyStart(sessionId: string, workspacePath: string, cols: number, rows: number): Promise<void> {
  await invoke("sandbox_pty_start", { sessionId, workspacePath, cols, rows });
}

export async function sandboxPtyWrite(sessionId: string, data: string): Promise<void> {
  await invoke("sandbox_pty_write", { sessionId, data });
}

export async function sandboxPtyResize(sessionId: string, cols: number, rows: number): Promise<void> {
  await invoke("sandbox_pty_resize", { sessionId, cols, rows });
}

export async function sandboxPtyClose(sessionId: string): Promise<void> {
  await invoke("sandbox_pty_close", { sessionId });
}

export async function connectRuntime(): Promise<boolean> {
  await waitForDaemon();
  const attempts = "__TAURI_INTERNALS__" in window ? 12 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await client.connect("127.0.0.1", 7437);
      if (!subscribed) {
        await client.request("event.subscribe", { topics: EVENT_TOPICS, scope: "global" });
        subscribed = true;
      }
      return true;
    } catch {
      if (attempt + 1 < attempts) await new Promise((resolve) => window.setTimeout(resolve, 250));
    }
  }
  return false;
}

export function onRuntimeEvent(handler: (event: Record<string, unknown>) => void): () => void {
  return client.onEvent(handler);
}

export function onRuntimeDisconnect(handler: (reason: string) => void): () => void {
  return client.onDisconnect(handler);
}

export async function listWorkspaces(): Promise<Workspace[]> {
  const result = await client.request("workspace.list");
  return (result.workspaces as Workspace[] | undefined) ?? [];
}

export async function listSessions(includeArchived = true): Promise<Session[]> {
  const result = await client.request("session.list", { limit: 100, include_archived: includeArchived });
  return (result.sessions as Session[] | undefined) ?? [];
}

export async function archiveWorkspace(workspaceId: string): Promise<Workspace> {
  const result = await client.request("workspace.archive", { workspace_id: workspaceId });
  return result.workspace as Workspace;
}

export async function resumeWorkspace(workspaceId: string): Promise<Workspace> {
  const result = await client.request("workspace.resume", { workspace_id: workspaceId });
  return result.workspace as Workspace;
}

export async function deleteWorkspace(workspaceId: string): Promise<void> {
  await client.request("workspace.delete", { workspace_id: workspaceId, confirm: "delete" });
}

export async function createSession(workspace: Workspace | null): Promise<string> {
  const result = await client.request("session.create", { mode: "chat", workspace_id: workspace?.workspace_id });
  return String(result.session_id);
}

export async function sessionHistory(sessionId: string): Promise<SessionHistory> {
  const result = await client.request("session.get_history", { session_id: sessionId });
  return {
    messages: (result.messages as unknown[] | undefined) ?? [],
    run_stats: (result.run_stats as Record<string, RunStats> | undefined) ?? {},
  };
}

export async function sendPrompt(sessionId: string, message: string, images: ImageBlock[] = []): Promise<string> {
  const result = await client.request("session.send_message", { session_id: sessionId, content: message, images });
  return String(result.run_id ?? "");
}

export async function renameSession(sessionId: string, title: string): Promise<Session> {
  const result = await client.request("session.rename", { session_id: sessionId, title });
  return result.session as Session;
}

export async function pinSession(sessionId: string, pinned: boolean): Promise<Session> {
  const result = await client.request("session.pin", { session_id: sessionId, pinned });
  return result.session as Session;
}

export async function archiveSession(sessionId: string): Promise<Session> {
  const result = await client.request("session.archive", { session_id: sessionId });
  return result.session as Session;
}

export async function resumeSession(sessionId: string): Promise<Session> {
  const result = await client.request("session.resume", { session_id: sessionId });
  return result.session as Session;
}

export async function closeSession(sessionId: string): Promise<void> {
  await client.request("session.close", { session_id: sessionId });
}

export async function deleteSession(sessionId: string): Promise<void> {
  await client.request("session.delete", { session_id: sessionId });
}

export async function compactSession(sessionId: string, focus = ""): Promise<{ summary_tokens: number; saved_tokens: number }> {
  return await client.request("session.compact", { session_id: sessionId, focus }) as { summary_tokens: number; saved_tokens: number };
}

export async function replayRun(runId: string): Promise<Record<string, unknown>[]> {
  const result = await client.request("run.replay", { run_id: runId, max_events: 10_000 });
  return (result.events as Record<string, unknown>[] | undefined) ?? [];
}

// 请求停止正在执行的 run；后端取消后通过 run.finished 事件通知前端
export async function cancelRun(runId: string): Promise<string> {
  const result = await client.request("run.cancel", { run_id: runId });
  return String(result.status ?? "");
}

export async function openWorkspace(path: string): Promise<Workspace> {
  const result = await client.request("workspace.open", { path });
  return result.workspace as Workspace;
}

export type WorkspaceStatus = { branch: string | null; is_git_repository: boolean; changed_file_count: number };

export async function workspaceStatus(workspaceId: string): Promise<WorkspaceStatus> {
  const result = await client.request("workspace.status", { workspace_id: workspaceId });
  return {
    branch: typeof result.branch === "string" ? result.branch : null,
    is_git_repository: Boolean(result.is_git_repository),
    changed_file_count: Number(result.changed_file_count ?? 0),
  };
}

export async function workspaceTree(workspaceId: string, path = "", maxDepth = 1): Promise<WorkspaceNode[]> {
  const result = await client.request("workspace.tree", { workspace_id: workspaceId, path, max_depth: maxDepth, max_entries: 1_000 });
  return (result.nodes as WorkspaceNode[] | undefined) ?? [];
}

export async function searchFiles(workspaceId: string, query: string): Promise<FileSearchMatch[]> {
  const result = await client.request("file.search", { workspace_id: workspaceId, query, max_results: 100 });
  return (result.matches as FileSearchMatch[] | undefined) ?? [];
}

export async function readFile(workspaceId: string, path: string): Promise<FileReadResult> {
  const result = await client.request("file.read", { workspace_id: workspaceId, path });
  return {
    content: String(result.content ?? ""),
    encoding: String(result.encoding ?? "UTF-8"),
    binary: Boolean(result.binary),
    truncated: Boolean(result.truncated),
    media_base64: typeof result.media_base64 === "string" ? result.media_base64 : null,
    mime_type: typeof result.mime_type === "string" ? result.mime_type : null,
  };
}

// 读取「添加附件」选中的本地文件（Tauri 侧），返回逐文件分类结果
export async function readAttachments(paths: string[]): Promise<Attachment[]> {
  return await invoke<Attachment[]>("read_attachment", { paths });
}

export async function listChanges(workspaceId: string, runId?: string | null): Promise<ChangeSummary[]> {
  const result = await client.request("change.list", { workspace_id: workspaceId, run_id: runId ?? null });
  return (result.changes as ChangeSummary[] | undefined) ?? [];
}

export async function changeDiff(workspaceId: string, path?: string): Promise<string> {
  const result = await client.request("change.diff", { workspace_id: workspaceId, path: path ?? null });
  return String(result.diff ?? "");
}

export async function revertChanges(workspaceId: string, runId: string, paths: string[]): Promise<{ reverted_paths: string[]; blocked_paths: Record<string, string> }> {
  return await client.request("change.revert", { workspace_id: workspaceId, run_id: runId, paths, confirm: "revert" }) as { reverted_paths: string[]; blocked_paths: Record<string, string> };
}

export async function stageChanges(workspaceId: string, paths: string[]): Promise<string[]> {
  const result = await client.request("change.stage", { workspace_id: workspaceId, paths });
  return (result.staged_paths as string[] | undefined) ?? [];
}

export async function getRuntimeSettings(): Promise<RuntimeSettings | null> {
  const result = await client.request("settings.get");
  return (result.settings as RuntimeSettings | undefined) ?? null;
}

export async function setRuntimeSettings(update: RuntimeSettingsUpdate): Promise<RuntimeSettings | null> {
  const result = await client.request("settings.update", update);
  return (result.settings as RuntimeSettings | undefined) ?? null;
}

export async function getProviderStatus(): Promise<ProviderStatus | null> {
  const result = await client.request("provider.status");
  return result as unknown as ProviderStatus;
}

export type CcswitchProvider = {
  id: string; name: string; base_url: string; model: string;
  has_api_key: boolean; is_current: boolean;
};

export async function listCcswitchProviders(): Promise<CcswitchProvider[]> {
  const result = await client.request("provider.ccswitch_list");
  return (result.providers as CcswitchProvider[] | undefined) ?? [];
}

export async function applyCcswitchProvider(providerId: string): Promise<RuntimeSettings | null> {
  const result = await client.request("provider.ccswitch_apply", { provider_id: providerId });
  return (result.settings as RuntimeSettings | undefined) ?? null;
}

export async function listModelProfiles(): Promise<ModelProfile[]> {
  const result = await client.request("provider.model_list");
  return (result.models as ModelProfile[] | undefined) ?? [];
}

export async function saveModelProfile(input: ModelProfileInput): Promise<{ settings: RuntimeSettings; models: ModelProfile[] }> {
  return await client.request("provider.model_save", input) as { settings: RuntimeSettings; models: ModelProfile[] };
}

export async function selectModelProfile(modelId: string): Promise<{ settings: RuntimeSettings; models: ModelProfile[] }> {
  return await client.request("provider.model_select", { model_id: modelId }) as { settings: RuntimeSettings; models: ModelProfile[] };
}

export async function deleteModelProfile(modelId: string): Promise<ModelProfile[]> {
  const result = await client.request("provider.model_delete", { model_id: modelId });
  return (result.models as ModelProfile[] | undefined) ?? [];
}

export async function respondPermission(toolUseId: string, decision: "allow_once" | "always_allow" | "deny_once" | "always_deny"): Promise<void> {
  await client.request("permission.respond", { tool_use_id: toolUseId, decision });
}
