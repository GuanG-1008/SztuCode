<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  AlertTriangle, Archive, ArrowLeft, BookOpen, CalendarClock, Check, ChevronDown, CirclePlus, Clock, Coins, Ellipsis, Folder, FolderOpen, FolderPlus, FolderSearch,
  GitBranch, Globe2, GripVertical, LayoutDashboard, MessageCircle, Minus, PanelLeftClose, PanelLeftOpen,
  Plus, Puzzle, RotateCcw, Search, Settings, ShieldCheck, Square, Terminal, Trash2, Wrench, X,
} from "@lucide/vue";
import { confirm, open as openDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import ProjectInspector from "./components/Inspector/ProjectInspector.vue";
import TaskSummaryPopup from "./components/Inspector/TaskSummaryPopup.vue";
import ModelConfigMenu from "./components/ModelConfig/ModelConfigMenu.vue";
import ModelManager from "./components/ModelConfig/ModelManager.vue";
import SessionActions from "./components/session/SessionActions.vue";
import ChatPortal, { type ChatView } from "./components/Chat/ChatPortal.vue";
import DiffReview from "./components/Diff/DiffReview.vue";
import BottomDiffPreview from "./components/Diff/BottomDiffPreview.vue";
import ExecutionTimeline from "./components/timeline/ExecutionTimeline.vue";
import SlashCommandMenu from "./components/CommandPalette/SlashCommandMenu.vue";
import SkillCenter from "./components/Skills/SkillCenter.vue";
import { slashMenuItems } from "./components/CommandPalette/slash-menu";
import type { PermissionDecision, PermissionState, PlanItem, TimelineEvent, TimelineStep, ToolCallEntry, WorkflowTaskEntry } from "./components/timeline/types";
import { isMacOSPlatform } from "./lib/platform";
import { appendTokenBatch, createTokenFrameBatcher } from "./utils/timelineStream";
import {
  applyCcswitchProvider, cancelRun, connectRuntime, createSession, deleteWorkspace, getNativeSettings, getProviderStatus, getRuntimeSettings, listCcswitchProviders, listSessions,
  listWorkspaces, onRuntimeDisconnect, onRuntimeEvent, openWorkspace, readAttachments, respondPermission,
  resumeWorkspace, sendPrompt, sessionHistory, setNativeSettings, setRuntimeSettings, workspaceStatus,
  type Attachment, type CcswitchProvider, type ImageBlock, type ProviderStatus, type RuntimeSettings, type Session, type Workspace,
} from "./services/sztu-runtime";

type Page = "work" | "chat" | "board" | "skills" | "automations" | "webbridge" | "settings" | "diff";
type ReviewContext = { workspaceId: string; runId: string; paths: string[] };
type RuntimeEvent = Record<string, unknown>;
const FULL_SIDEBAR_MIN_WIDTH = 952;
const FULL_SIDEBAR_MIN_HEIGHT = 640;
const SIDEBAR_MIN_WIDTH = 224;
const SIDEBAR_MAX_WIDTH = 360;
const SIDEBAR_COLLAPSE_PULL = 48;
// 会话区保留的最小宽度，用于钳制右侧功能栏宽度，避免窗口变窄时被挤没
const CONVERSATION_MIN_WIDTH = 320;
// 窗口窄于该宽度时自动收起右侧功能栏
const INSPECTOR_AUTO_COLLAPSE_WIDTH = 1000;
const page = ref<Page>("work");
const chatView = ref<ChatView>("home");
// 正式界面暂时隐藏入口；视觉测试可用开发态查询参数覆盖，避免整套 ChatPortal 回归被跳过。
const chatEntryVisible = import.meta.env.DEV
  && new URLSearchParams(window.location.search).get("visual-chat") === "1";
const sidebarCollapsed = ref(window.innerWidth < FULL_SIDEBAR_MIN_WIDTH || window.innerHeight < FULL_SIDEBAR_MIN_HEIGHT);
let sidebarAutoCollapsed = sidebarCollapsed.value;
const storedSidebarWidth = Number(localStorage.getItem("sztu.sidebarWidth"));
const sidebarWidth = ref(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, storedSidebarWidth || 268)));
const sidebarResizing = ref(false);
const sidebarAnimating = ref(false);
const sidebarCollapseArmed = ref(false);
const sidebarPull = ref(0);
const windowResizing = ref(false);
let stopSidebarDragListeners: (() => void) | undefined;
let sidebarAnimTimer: number | undefined;
let windowResizeEndTimer: number | undefined;
const connected = ref(false);
const loading = ref(true);
const workspaces = ref<Workspace[]>([]);
const workspace = ref<Workspace | null>(null);
const sessions = ref<Session[]>([]);
const activeId = ref<string | null>(null);
const timeline = ref<Map<number, TimelineStep>>(new Map());
const tokenBatcher = createTokenFrameBatcher(
  ({ runId, step, tokens }) => setStep(step, (current) => appendTokenBatch({ ...current, runId }, tokens)),
  (callback) => window.requestAnimationFrame(callback),
  (handle) => window.cancelAnimationFrame(handle),
);
const activeRunId = ref<string | null>(null);
// 当前会话是否正在执行 run（区别于 activeRunId：加载历史任务时 activeRunId 可能是已结束的 run）
const runActive = ref(false);
const prompt = ref("");
const activePrompt = ref<HTMLTextAreaElement | null>(null);
const launcherPrompt = ref<HTMLTextAreaElement | null>(null);
const slashMenuActiveIndex = ref(0);
const slashMenuDismissed = ref(false);
const selectedStarterTask = ref("");
const sending = ref(false);
const projectMenuOpen = ref(false);
const launcherProjectMenuOpen = ref(false);
const launcherProjectQuery = ref("");
const launcherPermissionMenuOpen = ref(false);
const permissionConfirmOpen = ref(false);
const permissionSaving = ref(false);
const permissionSettingsError = ref("");
const projectActionsOpen = ref<string | null>(null);
const sidebarToolsExpanded = ref(false);
const collapsedProjects = ref(new Set<string>());
const taskQuery = ref("");
const taskSearchOpen = ref(false);
const taskSearchInput = ref<HTMLInputElement | null>(null);
const inspectorOpen = ref(true);
const inspectorRendered = ref(true);
const inspectorWidth = ref(Math.min(720, Math.max(340, Number(localStorage.getItem("sztu.inspectorWidth")) || 390)));
// 响应式窗口宽度 + 窄窗自动收起右侧功能栏的追踪标志
const windowWidth = ref(window.innerWidth);
let inspectorAutoCollapsed = false;
// 「查看项目文件」请求：通知右侧功能栏切到文件标签页并浏览指定项目
const filesRequest = ref<{ workspaceId: string; seq: number } | null>(null);
let filesRequestSeq = 0;
let inspectorCloseTimer: ReturnType<typeof setTimeout> | undefined;
let inspectorOpenFrame: number | undefined;
// 待发送附件：图片走 base64 内容块，文本把内容注入消息
type PendingAttachment = {
  path: string; name: string; size: number;
  kind: "image" | "text";
  mime?: string;
  textContent?: string;
  dataBase64?: string;
};
const attachedFiles = ref<PendingAttachment[]>([]);
const providerStatus = ref<ProviderStatus | null>(null);
const runtimeSettings = ref<RuntimeSettings | null>(null);
const notifications = ref(localStorage.getItem("sztu.notifications") !== "false");
const autostart = ref(false);
const stayAwake = ref(false);
const nativeSettingsAvailable = ref(false);
const nativeSettingsError = ref("");
const webBridgeAllowed = ref(false);
const currentStepByRun = new Map<string, number>();
const runStepBase = new Map<string, number>(); // 每个 run 的 step 起点偏移，避免跨 run 步号冲突
const liveRunUsage = new Map<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens: number }>();
let historyLoadSeq = 0;
const reviewCtx = ref<ReviewContext | null>(null);
// 切换会话加载动画：超过 260ms 未返回时显示终端图标动效，避免快加载闪屏
const sessionLoading = ref(false);
let sessionLoadingTimer: ReturnType<typeof setTimeout> | undefined;
// 后台会话（非当前展示）正在等待审批的权限，切走后仍可审批，避免任务停滞
const pendingPermissions = ref<Array<{ toolUseId: string; toolName: string; preview: string; runId: string }>>([]);
const ccswitchOpen = ref(false);
const ccswitchLoading = ref(false);
const ccswitchApplying = ref<string | null>(null);
const ccswitchError = ref("");
const ccswitchProviders = ref<CcswitchProvider[]>([]);
const modelManagerOpen = ref(false);

const active = computed(() => sessions.value.find((item) => item.session_id === activeId.value) ?? null);
// 发送请求中或正在执行 run 时，把发送按钮切换为停止按钮
const isRunActive = computed(() => sending.value || runActive.value);
const activeWorkspace = computed(() => workspaces.value.find((item) => item.workspace_id === active.value?.workspace_id) ?? workspace.value);
const activeWorkspaces = computed(() => workspaces.value.filter((item) => !item.archived));
const archivedProjects = computed(() => workspaces.value.filter((item) => item.archived));
const liveSessions = computed(() => sessions.value.filter((item) => !item.archived));
const archivedSessions = computed(() => sessions.value.filter((item) => item.archived));
const recentSessions = computed(() => liveSessions.value.filter((item) => !item.workspace_id).slice(0, 6));
const normalizedTaskQuery = computed(() => taskQuery.value.trim().toLocaleLowerCase());
const matchesTaskQuery = (item: Session) => !normalizedTaskQuery.value || item.title.toLocaleLowerCase().includes(normalizedTaskQuery.value);
const visibleSessions = computed(() => liveSessions.value.filter(matchesTaskQuery));
const temporaryTasks = computed(() => visibleSessions.value.filter((item) => !item.workspace_id).slice(0, 5));
const projects = computed(() => activeWorkspaces.value
  .map((item) => {
    const projectMatches = item.name.toLocaleLowerCase().includes(normalizedTaskQuery.value);
    const candidates = normalizedTaskQuery.value && !projectMatches ? visibleSessions.value : liveSessions.value;
    return { ...item, tasks: candidates.filter((task) => task.workspace_id === item.workspace_id).slice(0, 6), projectMatches };
  })
  .filter((item) => !normalizedTaskQuery.value || item.projectMatches || item.tasks.length));
const filteredLauncherWorkspaces = computed(() => {
  const query = launcherProjectQuery.value.trim().toLocaleLowerCase();
  if (!query) return activeWorkspaces.value.slice(0, 6);
  return activeWorkspaces.value.filter((item) => `${item.name} ${item.path}`.toLocaleLowerCase().includes(query)).slice(0, 8);
});
const orderedTimeline = computed(() => [...timeline.value.values()].sort((left, right) => left.step - right.step));
// 聚合出最近一个已完成且有文件改动的 run，供会话区底部常驻 diff 预览使用（分组规则与时间线一致：新用户消息开新组，组内最后一步非末态视为运行中）
const latestChangedRun = computed(() => {
  let group: { runId?: string; paths: string[]; lastStatus?: TimelineStep["status"] } | null = null;
  let latest: { runId: string; paths: string[] } | null = null;
  for (const item of orderedTimeline.value) {
    if (item.userMessage) group = { runId: undefined, paths: [], lastStatus: undefined };
    if (!group) group = { runId: undefined, paths: [], lastStatus: undefined };
    if (item.runId) group.runId = item.runId;
    group.lastStatus = item.status;
    for (const entry of item.changes ?? []) {
      for (const path of entry.paths) {
        if (!group.paths.includes(path)) group.paths.push(path);
      }
    }
    const running =
      group.lastStatus === "thinking" || group.lastStatus === "acting" || group.lastStatus === "observing";
    if (!running && group.runId && group.paths.length) {
      latest = { runId: group.runId, paths: [...group.paths] };
    }
  }
  return latest;
});
// 历史会话不会重放 workspace.changed 事件；此时使用会话记录的最近 run
// 重新查询变更清单，让底部 Diff 在刷新或重新打开任务后仍可恢复。
const bottomDiffRun = computed(() => latestChangedRun.value ?? (
  active.value?.latest_run_id
    ? { runId: active.value.latest_run_id, paths: [] as string[] }
    : null
));
const permissionModeLabel = computed(() => ({
  normal: "标准审批",
  plan: "计划模式",
  accept_edits: "允许编辑",
  auto: "全部允许",
}[runtimeSettings.value?.permission_mode ?? "normal"]));
const taskStatusLabel = (item: Session) => item.status === "active" ? "等待输入" : item.status === "waiting_for_input" ? "已完成" : "已完成";
function formatSessionUsage(item: Session): string {
  const tokens = Number(item.total_input_tokens ?? 0) + Number(item.total_output_tokens ?? 0);
  const seconds = Number(item.total_elapsed_s ?? 0);
  const tokenText = tokens >= 1000 ? `${(tokens / 1000).toFixed(tokens >= 10000 ? 0 : 1)}k tokens` : `${tokens} tokens`;
  const durationText = seconds < 60 ? `${Math.round(seconds)}秒` : `${Math.floor(seconds / 60)}分${Math.round(seconds % 60)}秒`;
  return item.status === "active" && !tokens ? "计时中" : `${durationText} · ${tokenText}`;
}

// 对话条目悬停预览：展示计时、分支、项目目录与累计 token
const sessionPreview = ref<{ task: Session; top: number; left: number } | null>(null);
const branchCache = ref(new Map<string, string | null>());
type TaskTitleScrollState = { frame: number; direction: 1 | -1; lastAt: number; pauseUntil: number };
const taskTitleScrollStates = new WeakMap<HTMLElement, TaskTitleScrollState>();

function stopTaskTitleElementScroll(title: HTMLElement, reset = true) {
  const state = taskTitleScrollStates.get(title);
  if (state) cancelAnimationFrame(state.frame);
  taskTitleScrollStates.delete(title);
  if (reset) title.scrollLeft = 0;
}

function startTaskTitleScroll(event: FocusEvent) {
  const button = event.currentTarget as HTMLElement;
  const title = button.querySelector<HTMLElement>("[data-auto-scroll-title]");
  if (!title) return;
  stopTaskTitleElementScroll(title);
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const maxScroll = title.scrollWidth - title.clientWidth;
  if (maxScroll <= 1) return;
  const state: TaskTitleScrollState = {
    frame: 0,
    direction: 1,
    lastAt: performance.now(),
    pauseUntil: performance.now() + 650,
  };
  const tick = (now: number) => {
    if (!title.isConnected || document.activeElement !== button) {
      stopTaskTitleElementScroll(title);
      return;
    }
    const elapsed = Math.min(50, now - state.lastAt);
    state.lastAt = now;
    if (now >= state.pauseUntil) {
      title.scrollLeft += state.direction * elapsed * 0.035;
      if (title.scrollLeft >= maxScroll - 0.5) {
        title.scrollLeft = maxScroll;
        state.direction = -1;
        state.pauseUntil = now + 750;
      } else if (title.scrollLeft <= 0.5) {
        title.scrollLeft = 0;
        state.direction = 1;
        state.pauseUntil = now + 750;
      }
    }
    state.frame = requestAnimationFrame(tick);
  };
  taskTitleScrollStates.set(title, state);
  state.frame = requestAnimationFrame(tick);
}

function stopTaskTitleScroll(event: FocusEvent) {
  const title = (event.currentTarget as HTMLElement).querySelector<HTMLElement>("[data-auto-scroll-title]");
  if (title) stopTaskTitleElementScroll(title);
}

function showSessionPreview(task: Session, event: MouseEvent) {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  sessionPreview.value = { task, top: Math.max(4, Math.min(rect.top, window.innerHeight - 168)), left: Math.min(rect.right + 8, window.innerWidth - 232) };
  if (task.workspace_id && !branchCache.value.has(task.workspace_id)) void loadBranch(task.workspace_id);
}
function hideSessionPreview() { sessionPreview.value = null; }
// 分支信息按工作区缓存，避免每次悬停都触发 git 查询
async function loadBranch(workspaceId: string) {
  let branch: string | null = null;
  try { branch = (await workspaceStatus(workspaceId)).branch; } catch { branch = null; }
  const next = new Map(branchCache.value);
  next.set(workspaceId, branch);
  branchCache.value = next;
}
function previewBranch(task: Session): string {
  if (!task.workspace_id) return "—";
  const cached = branchCache.value.get(task.workspace_id);
  if (cached === undefined) return "…";
  return cached ?? "—";
}
function previewDirectory(task: Session): string {
  if (!task.workspace_id) return "临时任务";
  const found = workspaces.value.find((item) => item.workspace_id === task.workspace_id);
  return found ? found.path : "—";
}
function previewElapsed(task: Session): string {
  const seconds = Number(task.total_elapsed_s ?? 0);
  if (seconds < 60) return `${Math.round(seconds)} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${Math.round(seconds % 60)} 秒`;
}
function previewTokens(task: Session): string {
  const tokens = Number(task.total_input_tokens ?? 0) + Number(task.total_output_tokens ?? 0);
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(tokens >= 10000 ? 0 : 1)}k` : String(tokens);
}
// 工作区布局：仅传 CSS 变量，grid 列由样式表定义，
// 这样媒体查询能按窗口宽度覆盖列结构（内联 grid-template-columns 会锁死响应式，窗口变窄不重排）。
// 同时按当前窗口宽度钳制 inspector 宽度，保证会话区始终有 CONVERSATION_MIN_WIDTH 可用。
const workLayoutStyle = computed(() => {
  if (!inspectorOpen.value || !activeWorkspace.value) return { "--inspector-width": "0px" };
  const sidebarW = sidebarCollapsed.value ? 0 : sidebarWidth.value;
  const available = windowWidth.value - sidebarW - 6 - CONVERSATION_MIN_WIDTH;
  const clamped = Math.min(inspectorWidth.value, Math.max(280, available));
  return { "--inspector-width": `${clamped}px` };
});

async function toggleTaskSearch() {
  taskSearchOpen.value = !taskSearchOpen.value;
  if (taskSearchOpen.value) {
    await nextTick();
    taskSearchInput.value?.focus();
  }
}

function clearTaskSearch() {
  taskQuery.value = "";
  taskSearchOpen.value = false;
}
// 延迟卸载工作区面板，保证关闭动画完整播放
function setInspectorOpen(next: boolean) {
  if (inspectorCloseTimer) clearTimeout(inspectorCloseTimer);
  if (inspectorOpenFrame !== undefined) cancelAnimationFrame(inspectorOpenFrame);
  if (next) {
    inspectorRendered.value = true;
    inspectorOpenFrame = requestAnimationFrame(() => {
      inspectorOpen.value = true;
      inspectorOpenFrame = undefined;
    });
    return;
  }
  inspectorOpenFrame = undefined;
  inspectorOpen.value = false;
  inspectorCloseTimer = setTimeout(() => {
    inspectorRendered.value = false;
    inspectorCloseTimer = undefined;
  }, 240);
}
function toggleInspector() { setInspectorOpen(!inspectorOpen.value); }
// 拖拽分割线调整左右面板宽度比，并限制最小/最大宽度
function startDividerDrag(event: MouseEvent) {
  event.preventDefault();
  const startX = event.clientX;
  const startWidth = inspectorWidth.value;
  const container = (event.currentTarget as HTMLElement).parentElement;
  const maxWidth = Math.max(340, (container?.clientWidth ?? 1200) - 360); // 左侧对话区至少保留 360
  const minWidth = 340;
  function onMove(ev: MouseEvent) {
    inspectorWidth.value = Math.min(maxWidth, Math.max(minWidth, startWidth + (startX - ev.clientX)));
  }
  function onUp() {
    localStorage.setItem("sztu.inspectorWidth", String(inspectorWidth.value));
    document.body.style.cursor = "";
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  }
  document.body.style.cursor = "col-resize";
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}
const slashQuery = computed(() => {
  const match = prompt.value.match(/^\/([^\s]*)$/);
  return match ? match[1] : null;
});
const slashMenuOpen = computed(() => slashQuery.value !== null && !slashMenuDismissed.value);
const slashItems = computed(() => slashQuery.value === null ? [] : slashMenuItems(slashQuery.value, providerStatus.value?.skills ?? []));

type HistoryBlock = Record<string, unknown>;

function entryRole(entry: unknown) { return String((entry as { role?: unknown })?.role ?? "").toLowerCase(); }
function isRecord(value: unknown): value is HistoryBlock { return typeof value === "object" && value !== null && !Array.isArray(value); }
function historyBlocks(entry: unknown): HistoryBlock[] {
  const content = (entry as { content?: unknown })?.content;
  const values = Array.isArray(content) ? content : [content];
  return values.flatMap((value) => {
    if (typeof value === "string") {
      try {
        const parsed: unknown = JSON.parse(value);
        if (isRecord(parsed) && typeof parsed.type === "string") return [parsed];
      } catch { /* Ordinary text is not JSON. */ }
      return value ? [{ type: "text", text: value }] : [];
    }
    return isRecord(value) ? [value] : [];
  });
}
function blockText(block: HistoryBlock): string {
  if (typeof block.text === "string") return block.text;
  if (typeof block.content === "string") return block.content;
  return "";
}
function isHiddenHistoryBlock(block: HistoryBlock): boolean {
  const type = String(block.type ?? block.role ?? "").toLowerCase();
  return type === "system" || type === "developer" || type === "system_prompt" || type === "developer_prompt";
}
function isInternalHistoryMessage(blocks: HistoryBlock[]): boolean {
  const text = blocks.filter((block) => String(block.type) === "text").map(blockText).join("\n").trim();
  return /^\[Task progress\]\s+step_\d+/i.test(text)
    || /^This session is being continued from a previous conversation that ran out of context\.[\s\S]*\n\nSummary:\n/i.test(text)
    || /^Understood, I'll continue from this summary\.$/i.test(text);
}
function blockOutput(block: HistoryBlock): string {
  if (typeof block.content === "string") return block.content;
  if (Array.isArray(block.content)) return block.content.map((item) => typeof item === "string" ? item : JSON.stringify(item)).join("\n");
  return block.content ? JSON.stringify(block.content) : "";
}
function emptyStep(step: number): TimelineStep { return { step, status: "thinking", tokens: [], toolCalls: [] }; }
function appendTimelineEvent(step: TimelineStep, event: TimelineEvent): TimelineStep {
  const events = [...(step.events ?? [])];
  const existing = events.findIndex((item) => item.id === event.id);
  if (existing >= 0) events[existing] = { ...events[existing], ...event };
  else events.push(event);
  return { ...step, events };
}
function setStep(step: number, updater: (current: TimelineStep) => TimelineStep) {
  const next = new Map(timeline.value);
  next.set(step, updater(next.get(step) ?? emptyStep(step)));
  timeline.value = next;
}
function stepFor(event: RuntimeEvent): number {
  const runId = String(event.run_id ?? activeRunId.value ?? "");
  const existing = currentStepByRun.get(runId);
  if (existing !== undefined) return existing;
  const base = runStepBase.get(runId) ?? Math.max(0, ...timeline.value.keys());
  const fallback = base + 1;
  currentStepByRun.set(runId, fallback);
  return fallback;
}
function addUserMessage(content: string) {
  const step = Math.max(0, ...timeline.value.keys()) + 1;
  const startedAt = new Date().toISOString();
  setStep(step, (current) => ({ ...current, status: "thinking", userMessage: content, userMessageTime: startedAt, runStartedAt: startedAt }));
  return step;
}
function hydrateTimeline(messages: unknown[], runStats: Record<string, { input_tokens: number; output_tokens: number; elapsed_s: number }> = {}) {
  tokenBatcher.clear();
  const next = new Map<number, TimelineStep>();
  let step = 0;
  for (const message of messages) {
    const role = entryRole(message);
    if (role !== "user" && role !== "assistant") continue;
    const messageRunId = String((message as { run_id?: unknown })?.run_id ?? "") || undefined;
    const blocks = historyBlocks(message);
    // System/developer prompts are runtime context, never conversation output.
    if (role === "system" || role === "developer") continue;
    const visibleBlocks = blocks.filter((block) => !isHiddenHistoryBlock(block));
    if (!visibleBlocks.length) continue;
    // Canvas progress summaries are persisted as user messages for the model's
    // context, but they are internal bookkeeping and must not become chat turns.
    if (isInternalHistoryMessage(blocks)) continue;
    const text = visibleBlocks.filter((block) => String(block.type) === "text").map(blockText).filter(Boolean).join("\n");
    const toolResults = visibleBlocks.filter((block) => String(block.type) === "tool_result");
    if (role === "user" && toolResults.length && !text) {
      if (!step) step = 1;
      const current = next.get(step) ?? { ...emptyStep(step), status: "done" };
      const completed = current.toolCalls.map((call) => {
        const result = toolResults.find((item) => String(item.tool_use_id) === call.id);
        return result ? { ...call, status: result.is_error ? "failed" as const : "done" as const, output: blockOutput(result), error: result.is_error ? blockOutput(result) : undefined } : call;
      });
      const eventUpdates = completed.filter((call) => toolResults.some((item) => String(item.tool_use_id) === call.id)).reduce((events, call) => events.map((event) => event.toolCallId === call.id ? event : event), current.events ?? []);
      next.set(step, { ...current, status: "done", runId: messageRunId ?? current.runId, toolCalls: completed, events: eventUpdates });
      continue;
    }
    if (role === "user") {
      step += 1;
      next.set(step, {
        ...emptyStep(step),
        status: "done",
        runId: messageRunId,
        runStats: messageRunId && runStats[messageRunId] ? {
          inputTokens: Number(runStats[messageRunId].input_tokens ?? 0),
          outputTokens: Number(runStats[messageRunId].output_tokens ?? 0),
          cacheReadInputTokens: Number(runStats[messageRunId].cache_read_input_tokens ?? 0),
          elapsedSeconds: Number(runStats[messageRunId].elapsed_s ?? 0),
        } : undefined,
        userMessage: text,
        userMessageTime: String((message as { ts?: unknown })?.ts ?? ""),
      });
      continue;
    }
    if (!step) step = 1;
    const current = next.get(step) ?? { ...emptyStep(step), status: "done" };
    const thinking = visibleBlocks.filter((block) => String(block.type) === "thinking").map((block) => typeof block.thinking === "string" ? block.thinking : "").filter(Boolean).join("\n\n");
    const calls: ToolCallEntry[] = visibleBlocks.filter((block) => String(block.type) === "tool_use").map((block) => ({
      id: String(block.id ?? block.tool_use_id ?? crypto.randomUUID()),
      name: String(block.name ?? "工具调用"),
      params: isRecord(block.input) ? block.input : isRecord(block.params) ? block.params : {},
      status: "done",
    }));
    const events: TimelineEvent[] = visibleBlocks.flatMap((block, index) => {
      if (String(block.type) === "text" && blockText(block)) return [{ id: `text-${step}-${index}`, kind: "text", text: blockText(block) }];
      if (String(block.type) === "thinking" && typeof block.thinking === "string" && block.thinking) return [{ id: `thinking-${step}-${index}`, kind: "thinking", text: block.thinking }];
      if (String(block.type) === "tool_use") return [{ id: `tool-${String(block.id ?? block.tool_use_id ?? index)}`, kind: "tool", toolCallId: String(block.id ?? block.tool_use_id ?? index) }];
      return [];
    });
    next.set(step, {
      ...current,
      status: "done",
      runId: messageRunId ?? current.runId,
      runStats: messageRunId && runStats[messageRunId] ? {
        inputTokens: Number(runStats[messageRunId].input_tokens ?? 0),
        outputTokens: Number(runStats[messageRunId].output_tokens ?? 0),
        elapsedSeconds: Number(runStats[messageRunId].elapsed_s ?? 0),
      } : current.runStats,
      thinking: [current.thinking, thinking].filter(Boolean).join("\n\n") || undefined,
      finalText: [current.finalText, text].filter(Boolean).join("\n\n") || undefined,
      toolCalls: [...current.toolCalls, ...calls],
      events: [...(current.events ?? []), ...events],
    });
  }
  timeline.value = next;
}
function applyRuntimeEvent(event: RuntimeEvent) {
  const type = String(event.type ?? "");
  const runId = String(event.run_id ?? "");
  const relatedRunId = String(event.parent_run_id ?? runId);
  const timelineEvent = event.parent_run_id ? { ...event, run_id: relatedRunId } : event;
  if (type !== "llm.token" && relatedRunId) tokenBatcher.flushRun(relatedRunId);
  if (type === "run.started" && !activeRunId.value && sending.value) activeRunId.value = runId;
  if (type === "session.created" || type === "session.closed" || type === "session.waiting_for_input") {
    void refreshIndex();
    return;
  }
  // run 开始后刷新会话列表，让侧栏中的会话及时从"等待输入"移入"运行中"
  if (type === "run.started") void refreshIndex(false);
  // 权限审批是全局的：即使切到其他会话，后台任务的权限也要能审批，避免任务停滞
  if (type === "permission.requested") {
    const toolUseId = String(event.tool_use_id);
    const perm: PermissionState = { toolUseId, toolName: String(event.tool_name), preview: String(event.param_preview ?? "等待确认"), status: "pending" };
    if (relatedRunId === activeRunId.value) {
      const step = stepFor(timelineEvent);
      setStep(step, (current) => ({ ...current, status: "acting", permission: perm, toolCalls: current.toolCalls.map((call) => call.id === toolUseId ? { ...call, status: "awaiting_permission" } : call) }));
    } else if (!pendingPermissions.value.some((p) => p.toolUseId === toolUseId)) {
      pendingPermissions.value = [...pendingPermissions.value, { toolUseId, toolName: perm.toolName, preview: perm.preview, runId: relatedRunId }];
    }
    return;
  }
  if (type === "permission.granted" || type === "permission.denied") {
    const toolUseId = String(event.tool_use_id);
    pendingPermissions.value = pendingPermissions.value.filter((p) => p.toolUseId !== toolUseId);
    if (relatedRunId === activeRunId.value) {
      for (const step of timeline.value.keys()) setStep(step, (current) => current.permission?.toolUseId === toolUseId ? { ...current, permission: { ...current.permission, status: type === "permission.granted" ? "granted" : "denied" } } : current);
    }
    return;
  }
  // 运行事件没有 session_id，只消费由当前会话发送消息返回的 run_id，避免串到其他任务。
  if (!relatedRunId || relatedRunId !== activeRunId.value) return;
  if (type === "run.started") {
    const messageStep = Math.max(0, ...timeline.value.keys());
    setStep(messageStep || 1, (current) => ({ ...current, status: "thinking", runId, runStartedAt: String(event.ts ?? new Date().toISOString()) }));
    liveRunUsage.set(runId, { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 });
    return;
  }
  if (type === "step.started") {
    // 每个 run 的 step 从 1 编号，这里按 run 做偏移，保证跨 run 步号不冲突
    if (!runStepBase.has(runId)) runStepBase.set(runId, Math.max(0, ...timeline.value.keys()));
    const step = (runStepBase.get(runId) ?? 0) + Number(event.step);
    currentStepByRun.set(runId, step);
    setStep(step, (current) => ({ ...current, status: "thinking", runId }));
    return;
  }
  if (type === "llm.token") {
    const step = stepFor(timelineEvent);
    tokenBatcher.enqueue(relatedRunId, step, String(event.token ?? ""));
    return;
  }
  if (type === "llm.thinking") {
    const step = stepFor(timelineEvent);
    setStep(step, (current) => {
      const thinking = String(event.thinking ?? "");
      const events = [...(current.events ?? [])];
      const last = events[events.length - 1];
      if (last?.kind === "thinking") last.text = `${last.text ?? ""}${thinking}`;
      else events.push({ id: `thinking-live-${runId}-${Date.now()}`, kind: "thinking", text: thinking });
      return { ...current, thinking: `${current.thinking ?? ""}${thinking}`, events };
    });
    return;
  }
  if (type === "llm.usage") {
    const step = stepFor(timelineEvent);
    const inputTokens = Number(event.input_tokens ?? 0);
    const outputTokens = Number(event.output_tokens ?? 0);
    const cacheReadInputTokens = Number(event.cache_read_input_tokens ?? 0);
    const previous = liveRunUsage.get(relatedRunId) ?? { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 };
    const cumulative = {
      inputTokens: previous.inputTokens + inputTokens,
      outputTokens: previous.outputTokens + outputTokens,
      cacheReadInputTokens: previous.cacheReadInputTokens + cacheReadInputTokens,
    };
    liveRunUsage.set(relatedRunId, cumulative);
    setStep(step, (current) => ({
      ...current,
      runId: relatedRunId,
      usage: {
        inputTokens, outputTokens, contextPct: Number(event.context_pct ?? 0), model: String(event.model ?? ""),
        contextWindow: Number(event.context_window ?? 0), availableTokens: Number(event.available_tokens ?? 0),
        reservedOutputTokens: Number(event.reserved_output_tokens ?? 0), systemTokens: Number(event.system_tokens ?? 0),
        summaryTokens: Number(event.summary_tokens ?? 0), conversationTokens: Number(event.conversation_tokens ?? 0),
        toolTokens: Number(event.tool_tokens ?? 0),
      },
      runStats: { ...cumulative, elapsedSeconds: 0 },
    }));
    return;
  }
  if (type === "context.compacting" || type === "context.compacted") {
    const step = stepFor(timelineEvent);
    setStep(step, (current) => current.usage ? ({
      ...current,
      usage: {
        ...current.usage,
        compacting: type === "context.compacting",
        compactedTokens: type === "context.compacted"
          ? Math.max(0, Number(event.original_tokens ?? 0) - Number(event.summary_tokens ?? 0))
          : current.usage.compactedTokens,
      },
    }) : current);
    return;
  }
  if (type === "tool.call_started") {
    const step = stepFor(timelineEvent);
    const call: ToolCallEntry = { id: String(event.tool_use_id), name: String(event.tool_name), params: (event.params as Record<string, unknown>) ?? {}, status: "running" };
    setStep(step, (current) => appendTimelineEvent({ ...current, status: "acting", toolCalls: [...current.toolCalls.filter((item) => item.id !== call.id), call] }, { id: `tool-${call.id}`, kind: "tool", toolCallId: call.id }));
    return;
  }
  if (type === "tool.call_finished" || type === "tool.call_failed") {
    const step = stepFor(timelineEvent);
    const callId = String(event.tool_use_id);
    setStep(step, (current) => ({ ...current, status: "observing", toolCalls: current.toolCalls.map((call) => call.id !== callId ? call : { ...call, status: type === "tool.call_finished" ? "done" : "failed", output: type === "tool.call_finished" ? String(event.output ?? "") : undefined, error: type === "tool.call_failed" ? String(event.error_message ?? "工具调用失败") : undefined, elapsedMs: Number(event.elapsed_ms ?? 0) }) }));
    return;
  }
  if (type === "plan.updated") {
    const step = stepFor(timelineEvent);
    setStep(step, (current) => ({ ...current, plan: (event.items as PlanItem[] | undefined) ?? [] }));
    return;
  }
  if (type === "test.result") {
    const step = stepFor(timelineEvent);
    setStep(step, (current) => ({ ...current, tests: [...(current.tests ?? []), { status: String(event.status) === "passed" ? "passed" : "failed", summary: String(event.summary ?? "") }] }));
    return;
  }
  if (type === "change.applied") {
    const step = stepFor(timelineEvent);
    setStep(step, (current) => ({ ...current, changes: [...(current.changes ?? []), { paths: (event.paths as string[] | undefined) ?? [], workspacePath: String(event.workspace_path ?? "") }] }));
    return;
  }
  if (type === "log.line") {
    const step = stepFor(timelineEvent);
    setStep(step, (current) => ({ ...current, logs: [...(current.logs ?? []).slice(-99), { level: String(event.level ?? "INFO"), source: String(event.source ?? "daemon"), message: String(event.message ?? "") }] }));
    return;
  }
  if (type === "subagent.started") {
    const step = stepFor(timelineEvent);
    setStep(step, (current) => ({ ...current, subagents: [...(current.subagents ?? []).filter((agent) => agent.runId !== runId), { runId, description: String(event.description ?? ""), status: "running" }] }));
    return;
  }
  if (type === "subagent.finished") {
    for (const step of timeline.value.keys()) {
      setStep(step, (current) => ({ ...current, subagents: current.subagents?.map((agent) => agent.runId === runId ? { ...agent, status: String(event.status) === "success" ? "success" : "failed" } : agent) }));
    }
    return;
  }
  if (type === "workflow.started") {
    const step = stepFor(timelineEvent);
    const tasks = ((event.tasks as Record<string, unknown>[] | undefined) ?? []).map((task) => ({
      id: String(task.id ?? ""),
      title: String(task.title ?? ""),
      owner: String(task.owner ?? "coder") as WorkflowTaskEntry["owner"],
      status: String(task.status ?? "pending") as WorkflowTaskEntry["status"],
      dependencies: (task.dependencies as string[] | undefined) ?? [],
      completionCriteria: (task.completion_criteria as string[] | undefined) ?? [],
      allowedPaths: (task.allowed_paths as string[] | undefined) ?? [],
      attempt: Number(task.attempt ?? 0),
      error: String(task.error ?? "") || undefined,
    }));
    setStep(step, (current) => ({ ...current, workflowTasks: tasks }));
    return;
  }
  if (type === "workflow.task_updated") {
    const step = stepFor(timelineEvent);
    const task = (event.task as Record<string, unknown> | undefined) ?? {};
    const entry = {
      id: String(task.id ?? ""),
      title: String(task.title ?? ""),
      owner: String(task.owner ?? "coder") as WorkflowTaskEntry["owner"],
      status: String(task.status ?? "pending") as WorkflowTaskEntry["status"],
      dependencies: (task.dependencies as string[] | undefined) ?? [],
      completionCriteria: (task.completion_criteria as string[] | undefined) ?? [],
      allowedPaths: (task.allowed_paths as string[] | undefined) ?? [],
      attempt: Number(task.attempt ?? 0),
      error: String(task.error ?? "") || undefined,
    };
    setStep(step, (current) => ({ ...current, workflowTasks: [...(current.workflowTasks ?? []).filter((item) => item.id !== entry.id), entry] }));
    return;
  }
  if (type === "workflow.handoff") {
    const step = stepFor(timelineEvent);
    const artifact = (event.artifact as Record<string, unknown> | undefined) ?? {};
    setStep(step, (current) => ({ ...current, workflowHandoffs: [...(current.workflowHandoffs ?? []), {
      taskId: String(artifact.task_id ?? ""),
      role: String(artifact.role ?? "coder") as "planner" | "coder" | "tester" | "reviewer",
      status: String(artifact.status) === "failed" ? "failed" : "succeeded",
      summary: String(artifact.summary ?? ""),
      changedPaths: (artifact.changed_paths as string[] | undefined) ?? [],
      scopeEscalations: (artifact.scope_escalations as string[] | undefined) ?? [],
      commands: (artifact.commands as string[] | undefined) ?? [],
      output: String(artifact.output ?? ""),
      conclusion: String(artifact.conclusion ?? ""),
      childRunId: String(artifact.child_run_id ?? ""),
    }] }));
    return;
  }
  if (type === "workflow.reviewed") {
    const step = stepFor(timelineEvent);
    setStep(step, (current) => ({ ...current, workflowReviews: [...(current.workflowReviews ?? []), {
      taskId: String(event.task_id ?? ""),
      decision: String(event.decision) === "accept" ? "accept" : "return",
      diffSummary: String(event.diff_summary ?? ""),
      testSummary: String(event.test_summary ?? ""),
      securitySummary: String(event.security_summary ?? ""),
      conclusion: String(event.conclusion ?? ""),
    }] }));
    return;
  }
  if (type === "workflow.finished") {
    const step = stepFor(timelineEvent);
    setStep(step, (current) => ({ ...current, workflowOutcome: {
      status: String(event.status) as "succeeded" | "failed" | "cancelled" | "timed_out",
      reason: String(event.reason ?? ""),
      totalTokens: Number(event.total_tokens ?? 0),
      elapsedS: Number(event.elapsed_s ?? 0),
    } }));
    return;
  }
  if (type === "skill.invoked") {
    const step = stepFor(timelineEvent);
    setStep(step, (current) => ({ ...current, skills: [...(current.skills ?? []), { name: String(event.skill_name ?? ""), arguments: String(event.arguments ?? "") }] }));
    return;
  }
  if (type === "step.finished") {
    const step = Number(event.step ?? stepFor(timelineEvent));
    setStep(step, (current) => ({ ...current, status: current.status === "acting" ? "observing" : "done", finalText: current.finalText || current.streamText || current.tokens.join("") }));
    return;
  }
  if (type === "run.finished") {
    const runStatus = String(event.status);
    for (const step of timeline.value.keys()) {
      setStep(step, (current) => current.runId === relatedRunId ? {
        ...current,
        status: runStatus === "success" ? "done" : "failed",
        finalText: current.finalText || current.streamText || current.tokens.join(""),
        outcome: {
          status: runStatus === "interrupted" ? "interrupted" : (runStatus === "success" ? "success" : "failed"),
          reason: String(event.reason ?? "") || undefined,
        },
        runStats: {
          inputTokens: Number(event.total_input_tokens ?? 0),
          outputTokens: Number(event.total_output_tokens ?? 0),
          cacheReadInputTokens: Number(event.cache_read_input_tokens ?? 0),
          elapsedSeconds: Number(event.elapsed_s ?? 0),
        },
      } : current);
    }
    if (runId === activeRunId.value) activeRunId.value = null;
    runActive.value = false;
    liveRunUsage.delete(relatedRunId);
    void refreshIndex(false);
    return;
  }
}

async function refreshIndex(loadHistory = false) {
  connected.value = await connectRuntime();
  if (!connected.value) { loading.value = false; return; }
  const [nextWorkspaces, nextSessions, nextSettings, nextProvider] = await Promise.all([listWorkspaces(), listSessions(), getRuntimeSettings(), getProviderStatus()]);
  workspaces.value = nextWorkspaces; sessions.value = nextSessions; runtimeSettings.value = nextSettings; providerStatus.value = nextProvider;
  workspace.value ??= nextWorkspaces[0] ?? null;
  activeId.value ??= nextSessions.find((item) => !item.archived)?.session_id ?? null;
  if (loadHistory && activeId.value) {
    const history = await sessionHistory(activeId.value);
    hydrateTimeline(history.messages, history.run_stats);
  }
  loading.value = false;
}
function beginTask(project: Workspace | null = workspace.value) {
  historyLoadSeq += 1;
  projectActionsOpen.value = null;
  closeLauncherMenus();
  workspace.value = project;
  activeId.value = null;
  currentStepByRun.clear();
  runStepBase.clear();
  liveRunUsage.clear();
  timeline.value = new Map();
  activeRunId.value = null;
  runActive.value = false;
  attachedFiles.value = [];
  page.value = "work";
  prompt.value = "";
  selectedStarterTask.value = "";
  void nextTick(() => launcherPrompt.value?.focus());
}
async function submitTask(content: string, project: Workspace | null = workspace.value, images: ImageBlock[] = []) {
  const trimmed = content.trim();
  if (!trimmed || !connected.value || sending.value) return;
  const clientMessageId = crypto.randomUUID();
  sending.value = true;
  try {
    if (!activeId.value) {
      const sessionId = await createSession(project);
      activeId.value = sessionId;
      currentStepByRun.clear();
      runStepBase.clear();
      liveRunUsage.clear();
      timeline.value = new Map();
      activeRunId.value = null;
      page.value = "work";
      prompt.value = "";
      const messageStep = addUserMessage(trimmed);
      activeRunId.value = await sendPrompt(sessionId, trimmed, images, clientMessageId);
      runActive.value = true;
      setStep(messageStep, (current) => ({ ...current, runId: activeRunId.value ?? undefined }));
      await refreshIndex(false);
    } else {
      if (active.value?.archived || active.value?.status === "closed") return;
      prompt.value = "";
      const messageStep = addUserMessage(trimmed);
      activeRunId.value = await sendPrompt(activeId.value, trimmed, images, clientMessageId);
      runActive.value = true;
      setStep(messageStep, (current) => ({ ...current, runId: activeRunId.value ?? undefined }));
    }
  } finally { sending.value = false; }
}
// 停止当前正在执行的 run；后端取消后通过 run.finished 事件更新界面状态
async function stopActiveRun() {
  const runId = activeRunId.value;
  if (!runId) return;
  try {
    await cancelRun(runId);
  } catch (error) {
    window.alert(error instanceof Error ? error.message : String(error));
  }
}
async function chooseTask(id: string) {
  const loadSeq = ++historyLoadSeq;
  // 完整历史已含各轮内容，直接 hydrate 展示；replay 会与各 run 的 step 编号冲突导致旧日志混排
  const latestRunId = sessions.value.find((item) => item.session_id === id)?.latest_run_id ?? null;
  window.clearTimeout(sessionLoadingTimer);
  sessionLoading.value = false;
  sessionLoadingTimer = window.setTimeout(() => { sessionLoading.value = true; }, 260);
  let history;
  try {
    history = await sessionHistory(id);
  } catch (error) {
    if (loadSeq !== historyLoadSeq) return;
    window.clearTimeout(sessionLoadingTimer);
    sessionLoading.value = false;
    console.warn("Failed to load session history", error);
    return;
  }
  // 期间又切换了其他会话：放弃本次结果，且不干扰新请求的加载层
  if (loadSeq !== historyLoadSeq) return;
  window.clearTimeout(sessionLoadingTimer);
  sessionLoading.value = false;
  activeId.value = id;
  currentStepByRun.clear();
  runStepBase.clear();
  liveRunUsage.clear();
  activeRunId.value = null;
  runActive.value = false;
  hydrateTimeline(history.messages, history.run_stats);
  activeRunId.value = latestRunId;
  // 切到仍在执行的任务时恢复停止按钮；已结束的历史任务不显示
  runActive.value = !!latestRunId && sessions.value.find((item) => item.session_id === id)?.status === "active";
  page.value = "work";
}
async function chooseWorkspace(item: Workspace) { workspace.value = item; projectMenuOpen.value = false; const matching = liveSessions.value.find((session) => session.workspace_id === item.workspace_id); if (matching) await chooseTask(matching.session_id); }
function isProjectCollapsed(workspaceId: string) { return collapsedProjects.value.has(workspaceId); }
function toggleProject(workspaceId: string) {
  const next = new Set(collapsedProjects.value);
  if (next.has(workspaceId)) next.delete(workspaceId);
  else next.add(workspaceId);
  collapsedProjects.value = next;
  projectActionsOpen.value = null;
}
async function createProjectTask(item: Workspace) {
  projectActionsOpen.value = null;
  beginTask(item);
}
async function showProjectFiles(item: Workspace) {
  projectActionsOpen.value = null;
  // 跳转到右侧功能栏的「文件」标签页并浏览该项目（seq 递增保证重复点击也能触发）
  filesRequest.value = { workspaceId: item.workspace_id, seq: ++filesRequestSeq };
  workspace.value = item;
  setInspectorOpen(true);
  const matching = liveSessions.value.find((session) => session.workspace_id === item.workspace_id);
  if (matching) {
    await chooseTask(matching.session_id);
  } else if (!activeId.value) {
    // 无活动会话：为该工作区建一个会话，保证会话区 UI 不空白、可恢复
    const sessionId = await createSession(item);
    activeId.value = sessionId;
    currentStepByRun.clear();
    runStepBase.clear();
    timeline.value = new Map();
    page.value = "work";
    await refreshIndex(false);
  }
}
async function deleteProject(item: Workspace) {
  projectActionsOpen.value = null;
  const ok = await confirm(`删除项目「${item.name}」？将同时删除该项目的会话与上下文，磁盘文件保留。`, { title: "删除项目", kind: "warning" });
  if (!ok) return;
  try {
    await deleteWorkspace(item.workspace_id);
  } catch (error) {
    // 删除失败（如命中安全护栏）时保留列表并提示
    window.alert(error instanceof Error ? error.message : String(error));
    return;
  }
  workspaces.value = workspaces.value.filter((entry) => entry.workspace_id !== item.workspace_id);
  if (workspace.value?.workspace_id === item.workspace_id) {
    workspace.value = workspaces.value[0] ?? null;
    activeId.value = null;
    timeline.value = new Map();
  }
  await refreshIndex(false);
}
async function resumeProject(item: Workspace) {
  projectActionsOpen.value = null;
  const resumed = await resumeWorkspace(item.workspace_id);
  workspaces.value = workspaces.value.map((entry) => entry.workspace_id === resumed.workspace_id ? resumed : entry);
  workspace.value = resumed;
}
function handleSessionClosed(sessionId: string) {
  if (sessionId === activeId.value) closeActiveSession();
  else void refreshIndex(false);
}
async function submit() {
  const content = prompt.value.trim();
  if (!content || sending.value) return;
  if (activeId.value && (active.value?.archived || active.value?.status === "closed")) return;
  const mode = ({ "/plan": "plan", "/edits": "accept_edits", "/auto": "auto" } as const)[content as "/plan" | "/edits" | "/auto"];
  if (mode) {
    await choosePermissionMode(mode);
    prompt.value = "";
    slashMenuDismissed.value = false;
    void nextTick(() => (activeId.value ? activePrompt.value : launcherPrompt.value)?.focus());
    return;
  }
  const { content: payload, images } = buildMessagePayload(content);
  await submitTask(payload, workspace.value, images);
  attachedFiles.value = [];
}
// 回车直接发送；Ctrl/Shift/Alt + 回车保留默认换行行为，且忽略中文输入法候选确认
function onComposerKeydown(event: KeyboardEvent) {
  if (slashMenuOpen.value && !event.isComposing) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const count = slashItems.value.length;
      if (count) slashMenuActiveIndex.value = (slashMenuActiveIndex.value + (event.key === "ArrowDown" ? 1 : -1) + count) % count;
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      slashMenuDismissed.value = true;
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && slashItems.value.length) {
      event.preventDefault();
      chooseSkill(slashItems.value[Math.min(slashMenuActiveIndex.value, slashItems.value.length - 1)].name);
      return;
    }
  }
  if (event.key !== "Enter" || event.isComposing) return;
  if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
  event.preventDefault();
  void submit();
}
async function decidePermission(toolUseId: string, decision: PermissionDecision) { await respondPermission(toolUseId, decision); }
// 撤销后清除该 run 的全部改动，使变更卡片随之消失
function handleReverted(runId: string) {
  const next = new Map(timeline.value);
  for (const [step, item] of next) {
    if (item.runId === runId) next.set(step, { ...item, changes: [] });
  }
  timeline.value = next;
  void refreshIndex(false);
}
// 中断任务的"继续执行"：向当前会话补发一条续跑消息，复用交接摘要作为上下文
function handleContinue() {
  void submitTask("继续", null);
}
// 进入代码变更审核页
function handleReview(ctx: ReviewContext) {
  reviewCtx.value = ctx;
  page.value = "diff";
}
function closeReview() {
  reviewCtx.value = null;
  page.value = "work";
  void refreshIndex(false);
}
async function openLocalProject() {
  closeLauncherMenus();
  const selected = await openDialog({ directory: true, multiple: false, title: "打开本地项目" });
  if (typeof selected !== "string") return;
  workspace.value = await openWorkspace(selected);
  await refreshIndex(false);
  beginTask(workspace.value);
}
function closeLauncherMenus() {
  launcherProjectMenuOpen.value = false;
  launcherPermissionMenuOpen.value = false;
}
function toggleLauncherProjectMenu() {
  launcherProjectMenuOpen.value = !launcherProjectMenuOpen.value;
  launcherPermissionMenuOpen.value = false;
  if (!launcherProjectMenuOpen.value) launcherProjectQuery.value = "";
}
function toggleLauncherPermissionMenu() {
  launcherPermissionMenuOpen.value = !launcherPermissionMenuOpen.value;
  launcherProjectMenuOpen.value = false;
  permissionSettingsError.value = "";
}
function chooseLauncherWorkspace(item: Workspace) {
  workspace.value = item;
  closeLauncherMenus();
  launcherProjectQuery.value = "";
}
function clearLauncherWorkspace() {
  workspace.value = null;
  closeLauncherMenus();
  launcherProjectQuery.value = "";
}
async function createLocalWorkspace() {
  closeLauncherMenus();
  const selected = await openDialog({ directory: true, multiple: false, title: "新建工作空间：选择一个空文件夹" });
  if (typeof selected !== "string") return;
  workspace.value = await openWorkspace(selected);
  await refreshIndex(false);
  beginTask(workspace.value);
}
// 按 1KB/1MB 格式化附件大小
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function removeAttachment(index: number) { attachedFiles.value = attachedFiles.value.filter((_, i) => i !== index); }
// 从当前附件构造发送载荷：文本附件拼进 content，图片附件收集成 images 内容块
function buildMessagePayload(baseText: string): { content: string; images: ImageBlock[] } {
  const images: ImageBlock[] = [];
  const sections: string[] = [];
  for (const att of attachedFiles.value) {
    if (att.kind === "image" && att.dataBase64) {
      images.push({ media_type: att.mime ?? "image/png", data: att.dataBase64 });
    } else if (att.kind === "text" && att.textContent) {
      sections.push(`[附件: ${att.name}]\n\`\`\`\n${att.textContent}\n\`\`\``);
    }
  }
  return { content: [baseText, ...sections].filter(Boolean).join("\n\n"), images };
}
// 处理「添加附件」读取结果：图片/文本归档，超限或二进制在 error 中提示并跳过
function addReadAttachments(results: Attachment[]) {
  const added: PendingAttachment[] = [];
  for (const item of results) {
    if (item.error) { window.alert(`${item.name}：${item.error}`); continue; }
    if (item.mime_type?.startsWith("image/") && item.data_base64) {
      added.push({ path: item.path, name: item.name, size: item.size, kind: "image", mime: item.mime_type, dataBase64: item.data_base64 });
    } else if (item.is_text && item.text_content != null) {
      added.push({ path: item.path, name: item.name, size: item.size, kind: "text", textContent: item.text_content });
    } else {
      window.alert(`${item.name}：暂不支持作为附件`);
    }
  }
  if (added.length) attachedFiles.value = [...attachedFiles.value, ...added];
}
async function selectAttachments() {
  if ("__TAURI_INTERNALS__" in window) {
    const selected = await openDialog({ directory: false, multiple: true, title: "添加附件" });
    const paths = typeof selected === "string" ? [selected] : selected ?? [];
    if (!paths.length) return;
    addReadAttachments(await readAttachments(paths));
  } else {
    // 浏览器（非 Tauri）回退：用 file input 读取本地文件
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.style.display = "none";
    input.addEventListener("change", () => {
      for (const file of Array.from(input.files ?? [])) void addBrowserFile(file);
      input.remove();
    });
    document.body.appendChild(input);
    input.click();
  }
}
// 浏览器回退：把 File 读成图片 base64 或文本内容，附带同样的限制
async function addBrowserFile(file: File) {
  const isImage = file.type.startsWith("image/");
  const limit = isImage ? 5 * 1024 * 1024 : 1024 * 1024;
  if (file.size > limit) { window.alert(`${file.name} 超过 ${isImage ? "5MB" : "1MB"} 限制，已跳过`); return; }
  if (isImage) {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ""));
      reader.onerror = () => reject(new Error("读取图片失败"));
      reader.readAsDataURL(file);
    }).catch(() => "");
    const comma = dataUrl.indexOf(",");
    const dataBase64 = comma >= 0 ? dataUrl.slice(comma + 1) : "";
    if (dataBase64) attachedFiles.value = [...attachedFiles.value, { path: file.name, name: file.name, size: file.size, kind: "image", mime: file.type, dataBase64 }];
    return;
  }
  const textLike = !file.type || file.type.startsWith("text/") || ["application/json", "application/xml"].includes(file.type);
  if (!textLike) { window.alert(`${file.name}：暂不支持作为附件`); return; }
  const text = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("读取文件失败"));
    reader.readAsText(file);
  }).catch(() => "");
  attachedFiles.value = [...attachedFiles.value, { path: file.name, name: file.name, size: file.size, kind: "text", mime: file.type || undefined, textContent: text.slice(0, 32 * 1024) }];
}
function chooseSkill(name: string) {
  prompt.value = "/" + name + " ";
  slashMenuDismissed.value = false;
  void nextTick(() => (activeId.value ? activePrompt.value : launcherPrompt.value)?.focus());
}
function handlePromptInput() {
  selectedStarterTask.value = "";
  slashMenuDismissed.value = false;
  slashMenuActiveIndex.value = 0;
}
function chooseStarterTask(id: string, value: string) {
  selectedStarterTask.value = id;
  prompt.value = value;
  void nextTick(() => launcherPrompt.value?.focus());
}
function closeActiveSession() { historyLoadSeq += 1; tokenBatcher.clear(); activeId.value = null; timeline.value = new Map(); activeRunId.value = null; runActive.value = false; void refreshIndex(false); }
async function loadNativeSettings() {
  try {
    const settings = await getNativeSettings();
    autostart.value = settings.autostart;
    stayAwake.value = settings.stay_awake;
    nativeSettingsAvailable.value = settings.supported;
    nativeSettingsError.value = "";
  } catch {
    nativeSettingsAvailable.value = false;
  }
}
async function toggleAutostart(event: Event) {
  const enabled = (event.target as HTMLInputElement).checked;
  try {
    const settings = await setNativeSettings({ autostart: enabled });
    autostart.value = settings.autostart;
    nativeSettingsError.value = "";
  } catch (error) {
    nativeSettingsError.value = error instanceof Error ? error.message : String(error);
    (event.target as HTMLInputElement).checked = autostart.value;
  }
}
async function toggleStayAwake(event: Event) {
  const enabled = (event.target as HTMLInputElement).checked;
  try {
    const settings = await setNativeSettings({ stayAwake: enabled });
    stayAwake.value = settings.stay_awake;
    nativeSettingsError.value = "";
  } catch (error) {
    nativeSettingsError.value = error instanceof Error ? error.message : String(error);
    (event.target as HTMLInputElement).checked = stayAwake.value;
  }
}
async function applyPermissionMode(value: RuntimeSettings["permission_mode"]) {
  permissionSaving.value = true;
  permissionSettingsError.value = "";
  try {
    const result = await setRuntimeSettings({ permission_mode: value });
    if (result) runtimeSettings.value = result;
    launcherPermissionMenuOpen.value = false;
  } catch (error) {
    permissionSettingsError.value = error instanceof Error ? error.message : String(error);
  } finally {
    permissionSaving.value = false;
  }
}
async function choosePermissionMode(value: RuntimeSettings["permission_mode"]) {
  if (value === "auto" && runtimeSettings.value?.permission_mode !== "auto") {
    launcherPermissionMenuOpen.value = false;
    permissionConfirmOpen.value = true;
    return;
  }
  await applyPermissionMode(value);
}
async function confirmFullAccess() {
  await applyPermissionMode("auto");
  if (!permissionSettingsError.value) permissionConfirmOpen.value = false;
}
function handleModelConfigUpdated(settings: RuntimeSettings, status: ProviderStatus | null) {
  runtimeSettings.value = settings;
  providerStatus.value = status;
}
function openModelManager() { modelManagerOpen.value = true; }
// 加载本机 cc-switch 中可导入的供应商列表并展开面板
async function loadCcswitchProviders() {
  ccswitchLoading.value = true;
  ccswitchError.value = "";
  try {
    ccswitchProviders.value = await listCcswitchProviders();
    ccswitchOpen.value = true;
  } catch (error) {
    ccswitchError.value = error instanceof Error ? error.message : String(error);
  } finally {
    ccswitchLoading.value = false;
  }
}
// 应用选中的 cc-switch 供应商并刷新运行时设置与状态
async function useCcswitchProvider(providerId: string) {
  ccswitchApplying.value = providerId;
  ccswitchError.value = "";
  try {
    const settings = await applyCcswitchProvider(providerId);
    if (settings) runtimeSettings.value = settings;
    providerStatus.value = await getProviderStatus();
  } catch (error) {
    ccswitchError.value = error instanceof Error ? error.message : String(error);
  } finally {
    ccswitchApplying.value = null;
  }
}
function openPage(next: Page) { page.value = next; projectMenuOpen.value = false; closeLauncherMenus(); if (next === "chat") chatView.value = "home"; }
async function submitChat(content: string) {
  const { content: payload, images } = buildMessagePayload(content);
  await submitTask(payload, null, images);
  attachedFiles.value = [];
  page.value = "chat";
  chatView.value = "home";
}
const isMacOS = isMacOSPlatform();
async function minimizeWindow() { await getCurrentWindow().minimize(); }
// macOS：Rust 无动画 work-area fill，避开 NSWindow.zoom 与主面板不同步
async function toggleMaximizeWindow() {
  if (isMacOS) {
    await invoke("macos_toggle_work_area");
    return;
  }
  await getCurrentWindow().toggleMaximize();
}
async function closeWindow() { await getCurrentWindow().close(); }
let stopMacTitlebandDragArm: (() => void) | undefined;
// 顶栏空白区：移动超过阈值再拖窗，避免吞掉单击/双击；双击用 dblclick 最大化
function onMacTitlebandPointerDown(event: PointerEvent) {
  if (event.button !== 0) return;
  const target = event.target as HTMLElement | null;
  if (target?.closest(".nav-toggle-wrap, button, a, input, textarea, select, [role='button']")) return;
  if (event.detail >= 2) {
    event.preventDefault();
    return;
  }
  stopMacTitlebandDragArm?.();
  const startX = event.clientX;
  const startY = event.clientY;
  const onMove = (moveEvent: PointerEvent) => {
    if (Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < 4) return;
    stopMacTitlebandDragArm?.();
    void getCurrentWindow().startDragging().catch(() => undefined);
  };
  const onUp = () => { stopMacTitlebandDragArm?.(); };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp, { once: true });
  window.addEventListener("pointercancel", onUp, { once: true });
  stopMacTitlebandDragArm = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    stopMacTitlebandDragArm = undefined;
  };
}
async function onMacTitlebandDblClick(event: MouseEvent) {
  const target = event.target as HTMLElement | null;
  if (target?.closest(".nav-toggle-wrap, button, a, input, textarea, select, [role='button']")) return;
  event.preventDefault();
  stopMacTitlebandDragArm?.();
  try {
    await toggleMaximizeWindow();
  } catch (error) {
    console.error("toggleMaximizeWindow failed", error);
  }
}
function animateSidebarCollapsed(next: boolean) {
  sidebarAnimating.value = true;
  sidebarCollapsed.value = next;
  window.clearTimeout(sidebarAnimTimer);
  sidebarAnimTimer = window.setTimeout(() => { sidebarAnimating.value = false; }, 220);
}
function toggleSidebar() {
  animateSidebarCollapsed(!sidebarCollapsed.value);
  sidebarAutoCollapsed = false;
}
// 拖动边界调整导航宽度，越过最小宽度后的折叠阈值才收起导航
function startSidebarDrag(event: PointerEvent) {
  if (sidebarCollapsed.value || event.button !== 0) return;
  event.preventDefault();
  stopSidebarDragListeners?.();
  const startX = event.clientX;
  const startWidth = sidebarWidth.value;
  sidebarResizing.value = true;
  sidebarAutoCollapsed = false;
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
  const onMove = (moveEvent: PointerEvent) => {
    const rawWidth = startWidth + moveEvent.clientX - startX;
    const overPull = Math.max(0, SIDEBAR_MIN_WIDTH - rawWidth);
    sidebarWidth.value = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, rawWidth));
    sidebarPull.value = -Math.min(14, overPull * .28);
    sidebarCollapseArmed.value = overPull >= SIDEBAR_COLLAPSE_PULL;
  };
  const finish = () => {
    stopSidebarDragListeners?.();
    sidebarResizing.value = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    if (sidebarCollapseArmed.value) sidebarCollapsed.value = true;
    else localStorage.setItem("sztu.sidebarWidth", String(Math.round(sidebarWidth.value)));
    sidebarCollapseArmed.value = false;
    sidebarPull.value = 0;
  };
  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", finish, { once: true });
  document.addEventListener("pointercancel", finish, { once: true });
  stopSidebarDragListeners = () => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", finish);
    document.removeEventListener("pointercancel", finish);
    stopSidebarDragListeners = undefined;
  };
}
// 支持键盘在限定范围内调整导航宽度
function resizeSidebarWithKeyboard(event: KeyboardEvent) {
  let nextWidth = sidebarWidth.value;
  if (event.key === "ArrowLeft") nextWidth -= 16;
  else if (event.key === "ArrowRight") nextWidth += 16;
  else if (event.key === "Home") nextWidth = SIDEBAR_MIN_WIDTH;
  else if (event.key === "End") nextWidth = SIDEBAR_MAX_WIDTH;
  else return;
  event.preventDefault();
  sidebarWidth.value = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, nextWidth));
  localStorage.setItem("sztu.sidebarWidth", String(sidebarWidth.value));
}
function applySidebarAutoCollapse() {
  const belowFullSidebarSize = window.innerWidth < FULL_SIDEBAR_MIN_WIDTH || window.innerHeight < FULL_SIDEBAR_MIN_HEIGHT;
  if (belowFullSidebarSize) {
    if (!sidebarCollapsed.value) {
      animateSidebarCollapsed(true);
      sidebarAutoCollapsed = true;
    }
    return;
  }
  if (sidebarAutoCollapsed) {
    animateSidebarCollapsed(false);
    sidebarAutoCollapsed = false;
  }
}
function applyInspectorAutoCollapse() {
  // 窄窗口自动收起右侧功能栏，避免会话区被挤没
  if (window.innerWidth < INSPECTOR_AUTO_COLLAPSE_WIDTH) {
    if (inspectorOpen.value) {
      setInspectorOpen(false);
      inspectorAutoCollapsed = true;
    }
  } else if (inspectorAutoCollapsed) {
    inspectorAutoCollapsed = false;
    setInspectorOpen(true);
  }
}
function handleWindowResize() {
  windowWidth.value = window.innerWidth;
  windowResizing.value = true;
  window.clearTimeout(windowResizeEndTimer);
  windowResizeEndTimer = window.setTimeout(() => {
    windowResizing.value = false;
    // 先卸掉 window-resizing（transition:none），再播侧栏列宽动画
    void nextTick(() => {
      applySidebarAutoCollapse();
      applyInspectorAutoCollapse();
    });
  }, 120);
}
function handleGlobalShortcut(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "b") { event.preventDefault(); toggleSidebar(); }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); beginTask(); }
  if (event.key === "Escape") {
    if (permissionConfirmOpen.value) permissionConfirmOpen.value = false;
    else closeLauncherMenus();
  }
}
function handleDocumentPointerDown(event: PointerEvent) {
  const target = event.target as HTMLElement | null;
  if (!target?.closest(".launcher-project-control")) launcherProjectMenuOpen.value = false;
  if (!target?.closest(".launcher-permission-control")) launcherPermissionMenuOpen.value = false;
}
let stopEvents: (() => void) | undefined;
let stopDisconnect: (() => void) | undefined;
onMounted(() => {
  window.addEventListener("keydown", handleGlobalShortcut);
  window.addEventListener("resize", handleWindowResize);
  handleWindowResize(); // 初始化窗口宽度与窄窗自动收起状态
  document.addEventListener("pointerdown", handleDocumentPointerDown);
  stopDisconnect = onRuntimeDisconnect(() => { connected.value = false; });
  void loadNativeSettings();
  void refreshIndex(true).then(() => { stopEvents = onRuntimeEvent(applyRuntimeEvent); });
});
onBeforeUnmount(() => {
  tokenBatcher.clear();
  stopSidebarDragListeners?.();
  stopMacTitlebandDragArm?.();
  window.clearTimeout(sidebarAnimTimer);
  window.clearTimeout(windowResizeEndTimer);
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
  if (inspectorCloseTimer) clearTimeout(inspectorCloseTimer);
  if (inspectorOpenFrame !== undefined) cancelAnimationFrame(inspectorOpenFrame);
  if (sessionLoadingTimer) clearTimeout(sessionLoadingTimer);
  window.removeEventListener("keydown", handleGlobalShortcut);
  window.removeEventListener("resize", handleWindowResize);
  document.removeEventListener("pointerdown", handleDocumentPointerDown);
  stopEvents?.();
  stopDisconnect?.();
});
watch(page, (next) => { if (next === "skills" || next === "settings") void refreshIndex(false); });
watch(notifications, (enabled) => localStorage.setItem("sztu.notifications", String(enabled)));
</script>

<template>
  <div
    class="kimi-shell"
    :class="{ 'is-macos': isMacOS, 'sidebar-collapsed': sidebarCollapsed, 'sidebar-resizing': sidebarResizing, 'sidebar-animating': sidebarAnimating, 'sidebar-collapse-armed': sidebarCollapseArmed, 'window-resizing': windowResizing }"
    :style="{ '--sidebar-width': `${sidebarWidth}px`, '--sidebar-pull': `${sidebarPull}px` }"
  >
    <!-- macOS: fixed toolbar — toggle never moves between titlebar / sidebar. -->
    <header v-if="isMacOS" class="sidebar-macos-toolbar" @pointerdown="onMacTitlebandPointerDown" @dblclick="onMacTitlebandDblClick">
      <div class="nav-toggle-wrap" @pointerdown.stop @dblclick.stop>
        <button class="nav-toggle" type="button" aria-controls="primary-navigation" :aria-expanded="!sidebarCollapsed" :aria-label="sidebarCollapsed ? '\u5c55\u5f00\u5bfc\u822a' : '\u6536\u8d77\u5bfc\u822a'" @click="toggleSidebar">
          <PanelLeftOpen v-if="sidebarCollapsed" :size="16" :stroke-width="1.8" />
          <PanelLeftClose v-else :size="16" :stroke-width="1.8" />
        </button>
        <div class="nav-toggle-tooltip" role="tooltip"><span>{{ sidebarCollapsed ? '\u5c55\u5f00\u5bfc\u822a' : '\u6536\u8d77\u5bfc\u822a' }}</span><kbd>⌘</kbd><kbd>B</kbd></div>
      </div>
    </header>
    <header class="kimi-titlebar" :class="{ 'is-macos': isMacOS }">
      <div v-if="!isMacOS" class="nav-toggle-wrap">
        <button class="nav-toggle" type="button" aria-controls="primary-navigation" :aria-expanded="!sidebarCollapsed" :aria-label="sidebarCollapsed ? '\u5c55\u5f00\u5bfc\u822a' : '\u6536\u8d77\u5bfc\u822a'" @click="toggleSidebar">
          <PanelLeftOpen v-if="sidebarCollapsed" :size="16" :stroke-width="1.8" />
          <PanelLeftClose v-else :size="16" :stroke-width="1.8" />
        </button>
        <div class="nav-toggle-tooltip" role="tooltip"><span>{{ sidebarCollapsed ? '\u5c55\u5f00\u5bfc\u822a' : '\u6536\u8d77\u5bfc\u822a' }}</span><kbd>Ctrl</kbd><kbd>B</kbd></div>
      </div>
      <div v-if="isMacOS" class="titlebar-drag-region" @pointerdown="onMacTitlebandPointerDown" @dblclick="onMacTitlebandDblClick" />
      <div v-else class="titlebar-drag-region" data-tauri-drag-region @dblclick="toggleMaximizeWindow" />
      <div v-if="!isMacOS" class="window-actions" aria-label="Window controls">
        <button class="window-action" type="button" title="Minimize" aria-label="Minimize window" @click="minimizeWindow"><Minus :size="15" :stroke-width="1.8" /></button>
        <button class="window-action" type="button" title="Maximize or restore" aria-label="Maximize or restore window" @click="toggleMaximizeWindow"><Square :size="13" :stroke-width="1.8" /></button>
        <button class="window-action window-action--close" type="button" title="Close" aria-label="Close window" @click="closeWindow"><X :size="17" :stroke-width="1.8" /></button>
      </div>
    </header>

    <div class="sidebar-viewport">
      <aside id="primary-navigation" class="kimi-sidebar agent-sidebar">
      <header class="sidebar-brand">
        <h1>SztuCode</h1>
        <button class="task-search-toggle" type="button" title="搜索任务或项目" aria-label="搜索任务或项目" :aria-expanded="taskSearchOpen" aria-controls="task-search-field" @click="toggleTaskSearch">
          <Search :size="16" :stroke-width="1.8" aria-hidden="true" />
        </button>
      </header>

      <label v-if="taskSearchOpen || taskQuery" id="task-search-field" class="task-search">
        <Search :size="16" :stroke-width="1.8" aria-hidden="true" />
        <input ref="taskSearchInput" v-model="taskQuery" type="search" placeholder="搜索任务或项目" aria-label="搜索任务或项目" @keydown.esc="clearTaskSearch" />
        <button v-if="taskQuery" type="button" title="清除搜索" aria-label="清除搜索" @click="clearTaskSearch"><X :size="16" :stroke-width="1.8" /></button>
      </label>

      <div class="sidebar-command">
        <button class="new-task-button" @click="beginTask()"><CirclePlus :size="16" :stroke-width="1.8" />新建任务</button>
      </div>

      <nav class="sidebar-tools" aria-label="工作台工具">
        <button :class="{ active: page === 'board' }" @click="openPage('board')"><LayoutDashboard :size="16" :stroke-width="1.8" /><span>全部任务</span></button>
        <button :class="{ active: page === 'automations' }" @click="openPage('automations')"><CalendarClock :size="16" :stroke-width="1.8" /><span>自动化</span><small>即将推出</small></button>
        <button class="sidebar-more-trigger" :class="{ expanded: sidebarToolsExpanded }" :aria-expanded="sidebarToolsExpanded" aria-controls="sidebar-more-tools" @click="sidebarToolsExpanded = !sidebarToolsExpanded"><Ellipsis :size="16" :stroke-width="1.8" /><span>更多</span><ChevronDown :size="16" :stroke-width="1.8" /></button>
        <div v-if="sidebarToolsExpanded" id="sidebar-more-tools" class="sidebar-more-tools">
          <div>
            <button :class="{ active: page === 'skills' }" @click="openPage('skills')"><Puzzle :size="16" :stroke-width="1.8" /><span>技能</span></button>
            <button :class="{ active: page === 'webbridge' }" @click="openPage('webbridge')"><Globe2 :size="16" :stroke-width="1.8" /><span>浏览器连接</span></button>
            <button v-if="chatEntryVisible" :class="{ active: page === 'chat' }" @click="openPage('chat')"><MessageCircle :size="16" :stroke-width="1.8" /><span>通用问答</span></button>
          </div>
        </div>
      </nav>

      <div class="sidebar-workspace">
        <section v-if="normalizedTaskQuery" class="side-section search-results">
          <span class="side-label">搜索结果 <small>{{ visibleSessions.length }}</small></span>
          <div v-for="task in visibleSessions" :key="`search-${task.session_id}`" class="sidebar-session status-session" @mouseenter="showSessionPreview(task, $event)" @mouseleave="hideSessionPreview">
            <button class="status-task-row" :class="{ active: task.session_id === activeId }" @focus="startTaskTitleScroll" @blur="stopTaskTitleScroll" @click="chooseTask(task.session_id)">
              <i :class="task.status" /><span><b data-auto-scroll-title>{{ task.title || '未命名任务' }}</b><small>{{ taskStatusLabel(task) }} · {{ formatSessionUsage(task) }}</small></span>
            </button>
            <SessionActions :session="task" @changed="refreshIndex(false)" @closed="handleSessionClosed(task.session_id)" />
          </div>
          <p v-if="!visibleSessions.length" class="side-empty">没有匹配的任务</p>
        </section>

        <section class="side-section project-tree">
          <span class="side-label side-label--action">项目<button title="打开本地目录" aria-label="打开本地目录" @click="openLocalProject"><FolderOpen :size="16" :stroke-width="1.8" /></button></span>
          <div v-for="item in projects" :key="item.workspace_id" class="project-group">
            <div class="project-row-shell" :class="{ collapsed: isProjectCollapsed(item.workspace_id) }">
              <button class="project-row-toggle" :title="isProjectCollapsed(item.workspace_id) ? '展开项目' : '收起项目'" :aria-expanded="!isProjectCollapsed(item.workspace_id)" @click="toggleProject(item.workspace_id)">
                <FolderOpen v-if="!isProjectCollapsed(item.workspace_id)" :size="16" :stroke-width="1.8" />
                <Folder v-else :size="16" :stroke-width="1.8" />
                <span>{{ item.name }}</span>
              </button>
              <button class="side-item-action" title="项目操作" aria-label="项目操作" @click="projectActionsOpen = projectActionsOpen === item.workspace_id ? null : item.workspace_id"><Ellipsis :size="16" :stroke-width="1.8" /></button>
              <div v-if="projectActionsOpen === item.workspace_id" class="project-action-menu">
                <button @click="createProjectTask(item)"><Plus :size="16" :stroke-width="1.8" />新建任务</button>
                <button @click="showProjectFiles(item)"><FolderSearch :size="16" :stroke-width="1.8" />查看项目文件</button>
                <button @click="deleteProject(item)"><Trash2 :size="16" :stroke-width="1.8" />删除项目</button>
                <button @click="toggleProject(item.workspace_id)"><FolderOpen v-if="isProjectCollapsed(item.workspace_id)" :size="16" :stroke-width="1.8" /><Folder v-else :size="16" :stroke-width="1.8" />{{ isProjectCollapsed(item.workspace_id) ? '展开项目' : '收起项目' }}</button>
              </div>
            </div>
            <div class="project-task-list" :class="{ collapsed: isProjectCollapsed(item.workspace_id) }">
              <div class="project-task-list__inner">
                <div v-for="task in item.tasks" :key="task.session_id" class="sidebar-session project-session" @mouseenter="showSessionPreview(task, $event)" @mouseleave="hideSessionPreview">
                  <button class="project-task" :class="{ active: task.session_id === activeId }" @focus="startTaskTitleScroll" @blur="stopTaskTitleScroll" @click="chooseTask(task.session_id)">
                    <span data-auto-scroll-title>{{ task.title || '未命名任务' }}</span>
                  </button>
                  <SessionActions :session="task" @changed="refreshIndex(false)" @closed="handleSessionClosed(task.session_id)" />
                </div>
                <p v-if="!item.tasks.length" class="project-empty">没有聊天</p>
              </div>
            </div>
          </div>
          <p v-if="!projects.length && !normalizedTaskQuery" class="side-empty">打开本地目录以建立项目上下文</p>
        </section>

        <section v-if="temporaryTasks.length && !normalizedTaskQuery" class="side-section temporary-tasks">
          <span class="side-label">临时任务</span>
          <div v-for="task in temporaryTasks" :key="task.session_id" class="sidebar-session conversation-session" @mouseenter="showSessionPreview(task, $event)" @mouseleave="hideSessionPreview">
            <button class="conversation-row" :class="{ active: task.session_id === activeId }" @focus="startTaskTitleScroll" @blur="stopTaskTitleScroll" @click="chooseTask(task.session_id)"><span data-auto-scroll-title>{{ task.title || '未命名任务' }}</span></button>
            <SessionActions :session="task" @changed="refreshIndex(false)" @closed="handleSessionClosed(task.session_id)" />
          </div>
        </section>

        <details v-if="archivedProjects.length && !normalizedTaskQuery" class="archived-projects">
          <summary><Archive :size="16" :stroke-width="1.8" />已归档项目 <small>{{ archivedProjects.length }}</small></summary>
          <div v-for="item in archivedProjects" :key="item.workspace_id" class="project-row-shell">
            <button class="project-row archived-project-row" title="恢复项目" @click="resumeProject(item)"><RotateCcw :size="16" :stroke-width="1.8" /><span>{{ item.name }}</span></button>
          </div>
        </details>
      </div>

      <footer class="sidebar-footer">
        <div class="service-status"><i :class="{ online: connected }" /><span><b>本地服务</b><small>{{ connected ? '已连接' : '未连接' }}</small></span></div>
        <button class="settings-link" title="设置" aria-label="设置" @click="openPage('settings')"><Settings :size="16" :stroke-width="1.8" /></button>
      </footer>
      </aside>
    </div>
    <div
      class="sidebar-resizer"
      role="separator"
      aria-label="调整导航宽度"
      aria-controls="primary-navigation"
      aria-orientation="vertical"
      :aria-valuemin="SIDEBAR_MIN_WIDTH"
      :aria-valuemax="SIDEBAR_MAX_WIDTH"
      :aria-valuenow="Math.round(sidebarWidth)"
      tabindex="0"
      title="拖动调整导航宽度"
      @pointerdown="startSidebarDrag"
      @keydown="resizeSidebarWithKeyboard"
    ><span><GripVertical :size="13" :stroke-width="1.8" /></span></div>

    <div v-if="sessionPreview" class="session-preview" :style="{ top: `${sessionPreview.top}px`, left: `${sessionPreview.left}px` }" role="tooltip">
      <b class="session-preview__title">{{ sessionPreview.task.title || '未命名任务' }}</b>
      <div class="session-preview__row"><Clock :size="16" :stroke-width="1.8" /><span>计时</span><em>{{ previewElapsed(sessionPreview.task) }}</em></div>
      <div class="session-preview__row"><GitBranch :size="16" :stroke-width="1.8" /><span>分支</span><em>{{ previewBranch(sessionPreview.task) }}</em></div>
      <div class="session-preview__row"><Folder :size="16" :stroke-width="1.8" /><span>项目目录</span><em>{{ previewDirectory(sessionPreview.task) }}</em></div>
      <div class="session-preview__row"><Coins :size="16" :stroke-width="1.8" /><span>总 tokens</span><em>{{ previewTokens(sessionPreview.task) }}</em></div>
    </div>

    <main class="kimi-main" :class="{ 'chat-main': page === 'chat' }">
      <template v-if="page === 'work'">
        <section v-if="active" class="work-page">
          <div class="work-layout" :class="{ 'no-inspector': !inspectorOpen || !activeWorkspace }" :style="workLayoutStyle">
            <section class="task-canvas">
              <div v-if="sessionLoading" class="session-loading" role="status" aria-label="正在加载会话">
                <Terminal :size="40" :stroke-width="1.5" />
                <span>正在加载会话…</span>
              </div>
              <header class="work-header">
                <button class="workspace-trigger" @click="projectMenuOpen = !projectMenuOpen"><span>{{ activeWorkspace?.name || '未选择项目' }}</span><ChevronDown :size="14" /></button>
                <div v-if="projectMenuOpen" class="project-popover"><button v-for="item in activeWorkspaces" :key="item.workspace_id" @click="chooseWorkspace(item)">{{ item.name }}<small>{{ item.path }}</small></button></div>
                <div class="work-header__tools">
                  <SessionActions :session="active" @changed="refreshIndex(false)" @closed="closeActiveSession" />
                  <TaskSummaryPopup :workspace-id="activeWorkspace?.workspace_id ?? null" :run-id="active?.latest_run_id ?? null" :steps="orderedTimeline" :attachments="attachedFiles.map((item) => item.path)" :workspace-name="activeWorkspace?.name" :workspace-path="activeWorkspace?.path" @review="handleReview" />
                  <button class="workspace-panel-toggle" title="工作区" aria-label="工作区" :aria-expanded="inspectorOpen" :class="{ active: inspectorOpen }" @click="toggleInspector"><Folder :size="18" /></button>
                </div>
              </header>
              <div v-if="pendingPermissions.length" class="global-permission-banner" aria-live="polite">
                <div v-for="perm in pendingPermissions" :key="perm.toolUseId" class="global-permission-item">
                  <ShieldCheck :size="15" /><b>后台任务请求权限</b><span>{{ perm.toolName }} · {{ perm.preview }}</span>
                  <button type="button" @click="decidePermission(perm.toolUseId, 'deny_once')">拒绝</button>
                  <button type="button" class="allow" @click="decidePermission(perm.toolUseId, 'allow_once')">允许一次</button>
                </div>
              </div>
              <div class="task-conversation" :class="{ 'task-conversation--empty': !orderedTimeline.length }">
                <div class="task-stream">
                  <div v-if="!orderedTimeline.length" class="task-intro"><span class="task-intro-icon"><Terminal :size="36" :stroke-width="1.5" /></span><b>开启「{{ activeWorkspace?.name || '当前项目' }}」的构筑之路。</b></div>
                  <ExecutionTimeline :steps="orderedTimeline" :workspace-id="activeWorkspace?.workspace_id ?? undefined" @decide="decidePermission" @reverted="handleReverted" @review="handleReview" @continue="handleContinue" />
                </div>
                <BottomDiffPreview
                  v-if="bottomDiffRun"
                  :workspace-id="activeWorkspace?.workspace_id ?? null"
                  :run-id="bottomDiffRun.runId"
                  :paths="bottomDiffRun.paths"
                  @reverted="handleReverted"
                  @review="handleReview"
                />
                <form class="kimi-composer" @submit.prevent="submit">
                  <SlashCommandMenu v-if="slashMenuOpen" :query="slashQuery ?? ''" :skills="providerStatus?.skills ?? []" :connected="connected" :active-index="slashMenuActiveIndex" @activate="slashMenuActiveIndex = $event" @select="chooseSkill" />
                  <textarea ref="activePrompt" v-model="prompt" :disabled="active.archived || active.status === 'closed'" :placeholder="active.archived || active.status === 'closed' ? '恢复任务后继续' : '汝之所想，皆以言成'" rows="3" @input="handlePromptInput" @keydown="onComposerKeydown" />
                  <div v-if="attachedFiles.length" class="attachment-strip"><span v-for="(file, index) in attachedFiles" :key="file.path" class="attachment-chip" :class="'attachment-chip--' + file.kind"><img v-if="file.kind === 'image' && file.dataBase64" :src="'data:' + (file.mime || 'image/png') + ';base64,' + file.dataBase64" :alt="file.name" /><template v-else><b>{{ file.name }}</b><small>{{ formatSize(file.size) }}</small></template><button type="button" aria-label="移除附件" @click="removeAttachment(index)"><X :size="12" /></button></span></div>
                  <div class="composer-toolbar"><button type="button" class="round" title="添加上下文" aria-label="添加上下文" @click="selectAttachments"><Plus :size="18" /></button><button type="button" class="permission" @click="choosePermissionMode(runtimeSettings?.permission_mode === 'auto' ? 'normal' : 'auto')"><ShieldCheck :size="15" />{{ runtimeSettings?.permission_mode === 'auto' ? '全部允许' : '逐项审批' }}<ChevronDown :size="13" /></button><span /><ModelConfigMenu :settings="runtimeSettings" :status="providerStatus" @updated="handleModelConfigUpdated" @manage="openModelManager" /><button v-if="isRunActive" class="send stop" type="button" title="停止任务" aria-label="停止任务" @click="stopActiveRun"><Square :size="14" /></button><button v-else class="send" type="submit" aria-label="发送任务" :disabled="!prompt.trim() || active.archived || active.status === 'closed'">↑</button></div>
                </form>
              </div>
            </section>
            <template v-if="inspectorRendered && activeWorkspace">
              <div class="layout-divider" role="separator" aria-orientation="vertical" title="拖拽调整面板宽度" @mousedown="startDividerDrag" />
              <ProjectInspector
                :workspace-id="activeWorkspace.workspace_id"
                :run-id="active?.latest_run_id"
                :steps="orderedTimeline"
                :attachments="attachedFiles.map((item) => item.path)"
                :workspace-name="activeWorkspace.name"
                :workspace-path="activeWorkspace.path"
                :obscured="modelManagerOpen || permissionConfirmOpen"
                :files-request="filesRequest"
                @close="setInspectorOpen(false)"
              />
            </template>
          </div>
        </section>
        <section v-else class="landing-page task-launcher" :class="{ 'slash-open': slashMenuOpen }">
          <div class="launcher-content">
            <header class="launcher-heading">
              <span class="launcher-mark" aria-hidden="true"><BookOpen :size="42" :stroke-width="1.8" /></span>
              <div class="launcher-heading__copy">
                <h1 aria-label="心念为引，一言功毕"><span aria-hidden="true">心念为引，一言功毕</span></h1>
              </div>
            </header>

            <form class="kimi-composer landing-composer" @submit.prevent="submit()">
              <SlashCommandMenu v-if="slashMenuOpen" :query="slashQuery ?? ''" :skills="providerStatus?.skills ?? []" :connected="connected" :active-index="slashMenuActiveIndex" @activate="slashMenuActiveIndex = $event" @select="chooseSkill" />
              <textarea ref="launcherPrompt" v-model="prompt" placeholder="汝之所想，皆以言成" rows="4" @input="handlePromptInput" @keydown="onComposerKeydown" />
              <div v-if="attachedFiles.length" class="attachment-strip"><span v-for="(file, index) in attachedFiles" :key="file.path" class="attachment-chip" :class="'attachment-chip--' + file.kind"><img v-if="file.kind === 'image' && file.dataBase64" :src="'data:' + (file.mime || 'image/png') + ';base64,' + file.dataBase64" :alt="file.name" /><template v-else><b>{{ file.name }}</b><small>{{ formatSize(file.size) }}</small></template><button type="button" aria-label="移除附件" @click="removeAttachment(index)"><X :size="12" /></button></span></div>
              <div class="composer-toolbar launcher-toolbar">
                <button type="button" class="round" title="添加附件" aria-label="添加附件" @click="selectAttachments"><Plus :size="18" /></button>
                <div class="launcher-permission-control">
                  <button type="button" class="permission" aria-haspopup="menu" :aria-expanded="launcherPermissionMenuOpen" @click.stop="toggleLauncherPermissionMenu"><ShieldCheck :size="15" />{{ permissionModeLabel }}<ChevronDown :size="13" /></button>
                  <div v-if="launcherPermissionMenuOpen" class="launcher-popover permission-popover" role="menu" aria-label="权限模式">
                    <button type="button" class="full-access-row" role="menuitemcheckbox" :aria-checked="runtimeSettings?.permission_mode === 'auto'" @click="choosePermissionMode(runtimeSettings?.permission_mode === 'auto' ? 'normal' : 'auto')"><span><b>允许全部权限</b><small>跳过所有操作确认</small></span><i :class="{ active: runtimeSettings?.permission_mode === 'auto' }"><em /></i></button>
                    <p v-if="permissionSettingsError" class="launcher-menu-error">{{ permissionSettingsError }}</p>
                  </div>
                </div>
                <span />
                <ModelConfigMenu :settings="runtimeSettings" :status="providerStatus" @updated="handleModelConfigUpdated" @manage="openModelManager" />
                <button v-if="isRunActive" class="send stop" type="button" title="停止任务" aria-label="停止任务" @click="stopActiveRun"><Square :size="14" /></button><button v-else class="send" type="submit" aria-label="发送任务" :disabled="!connected || !prompt.trim()">↑</button>
              </div>
              <div class="launcher-project-control">
                <button type="button" class="composer-project" aria-haspopup="menu" :aria-expanded="launcherProjectMenuOpen" @click.stop="toggleLauncherProjectMenu"><FolderOpen :size="15" /><span>{{ workspace?.name || '选择本地项目' }}</span><ChevronDown :size="13" /></button>
                <div v-if="launcherProjectMenuOpen" class="launcher-popover project-picker-popover" role="menu" aria-label="选择项目">
                  <label class="project-picker-search"><Search :size="15" /><input v-model="launcherProjectQuery" type="search" placeholder="搜索工作空间" aria-label="搜索工作空间" /></label>
                  <div v-if="filteredLauncherWorkspaces.length" class="project-picker-list">
                    <button v-for="item in filteredLauncherWorkspaces" :key="item.workspace_id" type="button" role="menuitemradio" :aria-checked="workspace?.workspace_id === item.workspace_id" @click="chooseLauncherWorkspace(item)"><Folder :size="16" /><span><b>{{ item.name }}</b><small>{{ item.path }}</small></span><Check v-if="workspace?.workspace_id === item.workspace_id" :size="15" /></button>
                  </div>
                  <p v-else class="project-picker-empty">没有匹配的工作空间</p>
                  <div class="project-picker-actions">
                    <button v-if="workspace" type="button" role="menuitem" @click="clearLauncherWorkspace"><CirclePlus :size="16" /><span>临时任务<small>不关联项目上下文</small></span></button>
                    <button type="button" role="menuitem" @click="createLocalWorkspace"><FolderPlus :size="16" /><span>新建工作空间<small>选择一个空文件夹</small></span></button>
                    <button type="button" role="menuitem" @click="openLocalProject"><FolderOpen :size="16" /><span>打开本地文件夹<small>添加已有项目</small></span></button>
                  </div>
                </div>
              </div>
            </form>

            <section class="starter-tasks" aria-label="任务起步项">
              <span>从常见开发任务开始</span>
              <div>
                <button type="button" :class="{ selected: selectedStarterTask === 'understand' }" :aria-pressed="selectedStarterTask === 'understand'" @click="chooseStarterTask('understand', '分析当前项目结构、技术栈和关键模块，并给出一份简洁的项目导览。')"><FolderSearch :size="15" />理解项目</button>
                <button type="button" :class="{ selected: selectedStarterTask === 'fix' }" :aria-pressed="selectedStarterTask === 'fix'" @click="chooseStarterTask('fix', '检查当前项目中最值得优先修复的问题，说明原因并直接完成修复。')"><Wrench :size="15" />排查并修复</button>
                <button type="button" :class="{ selected: selectedStarterTask === 'review' }" :aria-pressed="selectedStarterTask === 'review'" @click="chooseStarterTask('review', '审查当前未提交的代码变更，重点检查缺陷、回归风险和缺失测试。')"><ShieldCheck :size="15" />审查变更</button>
                <button type="button" :class="{ selected: selectedStarterTask === 'plan' }" :aria-pressed="selectedStarterTask === 'plan'" @click="chooseStarterTask('plan', '根据当前项目状态，为下一项开发工作制定可执行的实现计划。')"><LayoutDashboard :size="15" />制定计划</button>
              </div>
            </section>
          </div>
        </section>
      </template>

      <section v-else-if="page === 'chat'"><ChatPortal :view="chatView" :connected="connected" @submit="submitChat" @navigate="chatView = $event" @open-project="openLocalProject" /></section>

      <section v-else-if="page === 'diff'" class="diff-page"><DiffReview v-if="reviewCtx" :workspace-id="reviewCtx.workspaceId" :run-id="reviewCtx.runId" :paths="reviewCtx.paths" @close="closeReview" @changed="refreshIndex(false)" /></section>

      <section v-else-if="page === 'board'" class="simple-page board-page">
        <header><div><h1>全部任务</h1><p>管理项目任务、临时任务与归档记录</p></div><button class="outline-button" @click="refreshIndex(false)">刷新</button></header>
        <div class="session-board">
          <article v-for="task in liveSessions" :key="task.session_id" :class="{ pinned: task.pinned }"><button @click="chooseTask(task.session_id)"><b>{{ task.title || 'Untitled task' }}</b><span>{{ task.status }} · {{ task.updated_at }}</span></button><SessionActions :session="task" @changed="refreshIndex(false)" @closed="refreshIndex(false)" /></article>
          <h2 v-if="archivedSessions.length">已归档</h2>
          <article v-for="task in archivedSessions" :key="task.session_id" class="archived"><button @click="chooseTask(task.session_id)"><b>{{ task.title || 'Untitled task' }}</b><span>{{ task.updated_at }}</span></button><SessionActions :session="task" @changed="refreshIndex(false)" @closed="refreshIndex(false)" /></article>
          <div v-if="!sessions.length" class="empty-state"><LayoutDashboard :size="58" /><h2>暂无会话</h2></div>
        </div>
      </section>
      <section v-else-if="page === 'automations'" class="chat-main"><ChatPortal view="automations" :connected="connected" @submit="submitChat" @navigate="(view) => { page = 'chat'; chatView = view }" @open-project="openLocalProject" /></section>

      <section v-else-if="page === 'skills'" class="chat-main"><SkillCenter :connected="connected" :workspace-id="activeWorkspace?.workspace_id ?? null" :workspace-name="activeWorkspace?.name ?? null" /></section>

      <section v-else-if="page === 'webbridge'" class="simple-page"><header><div><h1>浏览器连接</h1><p>连接浏览器，让 Agent 在授权范围内协助网页操作</p></div></header><div class="bridge-card"><Globe2 :size="24" /><div><h2>连接状态</h2><p>当前未连接。此功能需要浏览器扩展与本地服务支持。</p></div><span class="status-pill">未连接</span></div></section>

      <section v-else class="settings-screen"><header class="settings-top"><button title="返回工作区" aria-label="返回工作区" @click="openPage('work')"><ArrowLeft :size="19" /></button><h1>设置</h1></header><div class="settings-layout"><aside><span>SztuCode</span><button class="active">SztuCode Work</button></aside><main><section><span class="settings-section-label">系统设置</span><div class="setting-group"><label><div><b>开机自启动</b><p>登录系统时自动启动 SztuCode。</p></div><input :checked="autostart" type="checkbox" :disabled="!nativeSettingsAvailable" @change="toggleAutostart" /></label><label><div><b>系统通知</b><p>允许 SztuCode 发送任务结果与重要提醒。</p></div><input v-model="notifications" type="checkbox" /></label><label><div><b>保持电脑唤醒</b><p>任务运行期间阻止电脑进入睡眠。</p></div><input :checked="stayAwake" type="checkbox" :disabled="!nativeSettingsAvailable" @change="toggleStayAwake" /></label><p v-if="nativeSettingsError" class="native-settings-error">{{ nativeSettingsError }}</p></div></section><section><span class="settings-section-label">任务审批</span><div class="setting-group"><label class="stack"><b>权限模式</b><select :value="runtimeSettings?.permission_mode" @change="choosePermissionMode(($event.target as HTMLSelectElement).value as RuntimeSettings['permission_mode'])"><option value="normal">标准审批</option><option value="plan">计划模式</option><option value="accept_edits">允许编辑</option><option value="auto">全部允许</option></select></label></div></section><section><span class="settings-section-label">模型管理</span><div class="setting-group ccswitch-mgr"><div class="ccswitch-current-row"><div><b>当前模型</b><p>{{ runtimeSettings?.model || '未配置模型' }}<template v-if="runtimeSettings?.base_url"><br />{{ runtimeSettings.base_url }}</template></p></div><div class="model-management-actions"><button type="button" class="ccswitch-import-btn primary" @click="openModelManager"><Plus :size="14" />添加和管理模型</button><button type="button" class="ccswitch-import-btn" :disabled="ccswitchLoading" @click="ccswitchOpen ? (ccswitchOpen = false) : loadCcswitchProviders()">{{ ccswitchLoading ? '加载中…' : (ccswitchOpen ? '收起' : '从 cc-switch 导入') }}</button></div></div><div v-if="ccswitchOpen" class="ccswitch-list"><div v-for="item in ccswitchProviders" :key="item.id" class="ccswitch-card"><span class="ccswitch-card__dot" :class="{ has: item.has_api_key }" /><div class="ccswitch-card__info"><b>{{ item.name }}<em v-if="item.is_current">当前</em></b><span>{{ item.base_url }}</span><small>{{ item.model }}</small></div><button type="button" :disabled="ccswitchApplying === item.id" @click="useCcswitchProvider(item.id)">{{ ccswitchApplying === item.id ? '应用中…' : '使用此配置' }}</button></div><p v-if="!ccswitchProviders.length && !ccswitchLoading" class="ccswitch-empty">本机未发现可导入的 cc-switch 供应商，请确认已安装 CC Switch</p></div><p v-if="ccswitchError" class="native-settings-error">{{ ccswitchError }}</p></div></section><section><span class="settings-section-label">WebBridge</span><div class="setting-group"><label><div><b>允许网站所有操作</b><p>允许 Agent 在浏览器中执行已授权的网页动作。</p></div><input v-model="webBridgeAllowed" type="checkbox" disabled /></label><label><div><b>浏览器连接</b><p>显示 SztuCode 与本地浏览器扩展的连接状态。</p></div><em>未连接</em></label></div></section></main></div></section>
    </main>

    <div v-if="modelManagerOpen" class="model-manager-backdrop"><ModelManager @close="modelManagerOpen = false" @updated="handleModelConfigUpdated" /></div>

    <div v-if="permissionConfirmOpen" class="permission-confirm-backdrop" role="presentation" @mousedown.self="permissionConfirmOpen = false">
      <section class="permission-confirm" role="alertdialog" aria-modal="true" aria-labelledby="permission-confirm-title" aria-describedby="permission-confirm-description">
        <header><span><AlertTriangle :size="19" /></span><div><h2 id="permission-confirm-title">高风险权限提示</h2><p id="permission-confirm-description">允许全部权限后，Agent 将直接执行操作，不再逐次请求你的确认。</p></div></header>
        <div class="permission-confirm__body">
          <b>可能产生的后果</b>
          <ul><li>文件被覆盖、误删或损坏</li><li>系统配置被更改，导致软件异常</li><li>执行无法撤销的命令或外部操作</li></ul>
          <p><AlertTriangle :size="16" />部分操作不可逆，重要数据可能永久丢失。建议操作前备份重要内容。</p>
        </div>
        <footer><button type="button" @click="permissionConfirmOpen = false">取消</button><button type="button" class="danger" :disabled="permissionSaving" @click="confirmFullAccess">{{ permissionSaving ? '正在启用…' : '允许全部权限' }}</button></footer>
      </section>
    </div>
  </div>
</template>
