<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import {
  Activity, Check, CheckCircle2, ChevronDown, CircleAlert, FileDiff,
  LoaderCircle, PauseCircle, Play, ShieldAlert, TestTube2,
} from "@lucide/vue";
import ActivityDetails from "./ActivityDetails.vue";
import ChangeReviewCard from "../Diff/ChangeReviewCard.vue";
import ThinkingPanel from "./ThinkingPanel.vue";
import TokenStream from "./TokenStream.vue";
import ToolCallGroup from "./ToolCallGroup.vue";
import PermissionBadge from "./PermissionBadge.vue";
import type { PermissionDecision, PermissionState, PlanItem, RunStats, TimelineStep, ToolCallEntry } from "./types";

const props = defineProps<{ steps: TimelineStep[]; workspaceId?: string }>();
defineEmits<{
  decide: [toolUseId: string, decision: PermissionDecision];
  reverted: [runId: string];
  review: [ctx: { workspaceId: string; runId: string; paths: string[] }];
  continue: [runId?: string];
}>();

type TurnState = "running" | "waiting" | "verified" | "unverified" | "failed" | "interrupted";
type TurnView = {
  key: string | number;
  runId?: string;
  changePaths: string[];
  userMessage?: string;
  userMessageTime?: string;
  model?: string;
  runStats?: RunStats;
  runStartedAt?: string;
  hasContent: boolean;
  hasActivity: boolean;
  pending?: PermissionState;
  text: string;
  thinkingText: string;
  allToolCalls: ToolCallEntry[];
  aggregatedStep: TimelineStep;
  state: TurnState;
  stateLabel: string;
  failureReason?: string;
  passedTests: number;
  failedTests: number;
  completedPlan: number;
  planTotal: number;
};

const now = ref(Date.now());
let clockTimer: number | undefined;
onMounted(() => { clockTimer = window.setInterval(() => { now.value = Date.now(); }, 1000); });
onBeforeUnmount(() => window.clearInterval(clockTimer));

function thinkingTextOf(steps: TimelineStep[]): string {
  return [...new Set(steps.map((step) => step.thinking?.trim()).filter(Boolean))].join("\n\n");
}

function toolCallsOf(steps: TimelineStep[]): ToolCallEntry[] {
  return [...new Map(steps.flatMap((step) => step.toolCalls).map((call) => [call.id, call])).values()];
}

function latestPlanOf(steps: TimelineStep[]): PlanItem[] {
  return [...steps].reverse().find((step) => step.plan?.length)?.plan ?? [];
}

function aggregateStep(steps: TimelineStep[]): TimelineStep {
  return {
    step: steps[0]?.step ?? 0,
    status: steps.some((step) => step.status === "failed") ? "failed" : "done",
    tokens: [],
    toolCalls: [],
    thinking: "",
    plan: latestPlanOf(steps),
    tests: steps.flatMap((step) => step.tests ?? []),
    changes: steps.flatMap((step) => step.changes ?? []),
    subagents: steps.flatMap((step) => step.subagents ?? []),
    skills: steps.flatMap((step) => step.skills ?? []),
    logs: steps.flatMap((step) => step.logs ?? []),
    workflowTasks: [...steps].reverse().find((step) => step.workflowTasks?.length)?.workflowTasks ?? [],
    workflowHandoffs: steps.flatMap((step) => step.workflowHandoffs ?? []),
    workflowReviews: steps.flatMap((step) => step.workflowReviews ?? []),
    workflowOutcome: [...steps].reverse().find((step) => step.workflowOutcome)?.workflowOutcome,
  };
}

function hasAssistantContent(step: TimelineStep): boolean {
  return Boolean(
    step.finalText || step.tokens.length || step.thinking || step.toolCalls.length ||
    step.plan?.length || step.tests?.length || step.changes?.length ||
    step.logs?.length || step.subagents?.length || step.skills?.length ||
    step.runStartedAt || step.runStats || step.workflowTasks?.length ||
    step.workflowHandoffs?.length || step.workflowReviews?.length,
  );
}

function actionLabel(call: ToolCallEntry): string {
  const name = call.name.toLowerCase();
  if (/read|list_dir/.test(name)) return "正在阅读项目文件";
  if (/grep|glob|search/.test(name)) return "正在项目中定位代码";
  if (/edit|write/.test(name)) return "正在修改工作区文件";
  if (/bash|shell|test/.test(name)) return "正在运行命令并验证结果";
  if (/task|subagent/.test(name)) return "正在协调子任务";
  return "正在执行项目操作";
}

function failureLabel(reason?: string): string {
  if (!reason) return "执行失败，详情见工作记录";
  if (reason === "cancelled") return "任务已取消";
  if (reason === "llm_error") return "模型调用失败";
  if (reason === "permission_denied") return "操作被权限策略拦截";
  return `执行失败：${reason}`;
}

// 中断（预算/上限耗尽）状态文案：区别于失败，明确告知可续跑
function interruptedLabel(reason?: string): string {
  if (reason === "max_tokens_exceeded") return "Token 预算用尽，可继续";
  if (reason === "max_wall_clock_exceeded") return "墙钟预算用尽，可继续";
  return "步数预算用尽，可继续";
}

// 将 ISO 时间戳格式化为可读的本地时间，空值返回空串
function formatTime(iso?: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatDuration(seconds: number): string {
  if (seconds < 1) return `${Math.round(seconds * 1000)} ms`;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return remainder ? `${minutes} 分 ${remainder} 秒` : `${minutes} 分钟`;
}

function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(tokens >= 10000 ? 0 : 1)}k` : String(tokens);
}

function liveStatsLabel(turn: TurnView): string {
  const startedAt = turn.runStartedAt ? new Date(turn.runStartedAt).getTime() : Number.NaN;
  const elapsed = turn.state === "running" || turn.state === "waiting"
    ? (Number.isNaN(startedAt) ? turn.runStats?.elapsedSeconds ?? 0 : Math.max(0, (now.value - startedAt) / 1000))
    : turn.runStats?.elapsedSeconds ?? 0;
  const totalTokens = (turn.runStats?.inputTokens ?? 0) + (turn.runStats?.outputTokens ?? 0);
  return `${formatDuration(elapsed)} · ${formatTokens(totalTokens)} tokens`;
}

function stateOf(steps: TimelineStep[], pending: PermissionState | undefined, calls: ToolCallEntry[], text: string) {
  if (pending) return { state: "waiting" as const, label: "等待你的授权" };
  const interruptedOutcome = [...steps].reverse().find((step) => step.outcome?.status === "interrupted")?.outcome;
  if (interruptedOutcome) return { state: "interrupted" as const, label: interruptedLabel(interruptedOutcome.reason), reason: interruptedOutcome.reason };
  const failedOutcome = [...steps].reverse().find((step) => step.outcome?.status === "failed")?.outcome;
  if (failedOutcome) return { state: "failed" as const, label: failureLabel(failedOutcome.reason), reason: failedOutcome.reason };
  const runningCall = [...calls].reverse().find((call) => call.status === "running" || call.status === "awaiting_permission");
  if (runningCall) return { state: "running" as const, label: actionLabel(runningCall) };
  const last = steps[steps.length - 1];
  if (last && last.status !== "done") {
    if (last.status === "observing") return { state: "running" as const, label: "正在检查执行结果" };
    if (last.tokens.length && !last.finalText) return { state: "running" as const, label: "正在整理交付结果" };
    return { state: "running" as const, label: calls.length ? "正在规划下一步" : "正在理解任务与项目" };
  }
  const tests = steps.flatMap((step) => step.tests ?? []);
  if (tests.some((test) => test.status === "failed")) return { state: "failed" as const, label: "已完成，但验证未通过" };
  if (text && tests.some((test) => test.status === "passed")) return { state: "verified" as const, label: "已完成并验证" };
  return { state: "unverified" as const, label: text ? "已完成，尚未验证" : "工作记录" };
}

const turns = computed<TurnView[]>(() => {
  const groups: { userMessage?: string; userMessageTime?: string; steps: TimelineStep[] }[] = [];
  for (const item of props.steps) {
    if (item.userMessage) {
      const group = { userMessage: item.userMessage, userMessageTime: item.userMessageTime, steps: [] as TimelineStep[] };
      groups.push(group);
      if (hasAssistantContent(item)) group.steps.push(item);
    } else {
      if (!groups.length) groups.push({ steps: [] });
      groups[groups.length - 1].steps.push(item);
    }
  }
  return groups.map((group, index) => {
    const steps = group.steps;
    const model = steps.find((step) => step.usage?.model)?.usage?.model ?? "";
    const runStats = [...steps].reverse().find((step) => step.runStats)?.runStats;
    const runStartedAt = steps.find((step) => step.runStartedAt)?.runStartedAt ?? group.userMessageTime;
    const text = steps.map((step) => step.finalText || step.tokens.join("")).filter(Boolean).join("\n\n");
    const allToolCalls = toolCallsOf(steps);
    const thinkingText = thinkingTextOf(steps);
    const aggregatedStep = aggregateStep(steps);
    const pending = steps.find((step) => step.permission?.status === "pending")?.permission;
    const status = stateOf(steps, pending, allToolCalls, text);
    const tests = aggregatedStep.tests ?? [];
    const plan = aggregatedStep.plan ?? [];
    const changePaths = [...new Set(aggregatedStep.changes?.flatMap((entry) => entry.paths) ?? [])];
    const hasActivity = Boolean(
      allToolCalls.length || thinkingText || plan.length || aggregatedStep.subagents?.length ||
      aggregatedStep.skills?.length || aggregatedStep.logs?.length ||
      aggregatedStep.workflowTasks?.length || aggregatedStep.workflowHandoffs?.length ||
      aggregatedStep.workflowReviews?.length,
    );
    return {
      key: steps.find((step) => step.runId)?.runId ?? `turn-${index}`,
      runId: steps.find((step) => step.runId)?.runId,
      changePaths,
      userMessage: group.userMessage,
      userMessageTime: group.userMessageTime,
      model,
      runStats,
      runStartedAt,
      hasActivity,
      pending,
      text,
      thinkingText,
      allToolCalls,
      aggregatedStep,
      state: status.state,
      stateLabel: status.label,
      failureReason: status.reason,
      passedTests: tests.filter((test) => test.status === "passed").length,
      failedTests: tests.filter((test) => test.status === "failed").length,
      completedPlan: plan.filter((item) => item.status === "completed").length,
      planTotal: plan.length,
      hasContent: Boolean(text || hasActivity || pending || steps.length),
    };
  });
});
</script>

<template>
  <section class="execution-timeline" aria-live="polite">
    <article v-for="turn in turns" :key="turn.key" class="timeline-step">
      <div v-if="turn.userMessage" class="timeline-user-message">
        {{ turn.userMessage }}
        <span v-if="turn.model || turn.userMessageTime" class="timeline-user-message__meta">{{ turn.model || "未记录模型" }} · {{ formatTime(turn.userMessageTime) }}</span>
      </div>
      <div v-if="turn.hasContent" class="timeline-assistant">
        <span class="assistant-avatar" :class="turn.state" aria-label="SztuCode">
          <LoaderCircle v-if="turn.state === 'running'" class="spin" :size="15" />
          <ShieldAlert v-else-if="turn.state === 'waiting'" :size="15" />
          <PauseCircle v-else-if="turn.state === 'interrupted'" :size="15" />
          <CircleAlert v-else-if="turn.state === 'failed'" :size="15" />
          <Check v-else :size="15" />
        </span>
        <div class="timeline-step__content">
          <div class="turn-status" :class="turn.state">
            <b>{{ turn.stateLabel }}</b>
            <span v-if="turn.runStartedAt || turn.runStats" class="turn-status__usage">（{{ liveStatsLabel(turn) }}）</span>
            <span v-if="turn.state === 'running' && turn.planTotal">{{ turn.completedPlan }}/{{ turn.planTotal }} 项</span>
          </div>

          <PermissionBadge v-if="turn.pending" :permission="turn.pending" @decide="$emit('decide', turn.pending?.toolUseId ?? '', $event)" />

          <section v-if="turn.text" class="turn-result" aria-label="任务结果">
            <TokenStream :tokens="[]" :final-text="turn.text" />
          </section>

          <div v-if="turn.runStats" class="turn-usage" aria-label="本轮耗时和 Token 消耗">
            <span>{{ formatDuration(turn.runStats.elapsedSeconds) }}</span>
            <span>输入 {{ formatTokens(turn.runStats.inputTokens) }}</span>
            <span>输出 {{ formatTokens(turn.runStats.outputTokens) }}</span>
            <b>总计 {{ formatTokens(turn.runStats.inputTokens + turn.runStats.outputTokens) }} tokens</b>
          </div>

          <section v-if="turn.text || turn.failedTests || turn.changePaths.length" class="evidence-strip" aria-label="验证与变更">
            <div v-if="turn.passedTests" class="evidence-item passed"><CheckCircle2 :size="15" /><span><b>{{ turn.passedTests }}</b> 项验证通过</span></div>
            <div v-if="turn.failedTests" class="evidence-item failed"><CircleAlert :size="15" /><span><b>{{ turn.failedTests }}</b> 项验证失败</span></div>
            <div v-if="turn.text && !turn.passedTests && !turn.failedTests" class="evidence-item unverified"><TestTube2 :size="15" /><span>没有结构化测试记录</span></div>
            <div v-if="turn.changePaths.length" class="evidence-item changed"><FileDiff :size="15" /><span><b>{{ turn.changePaths.length }}</b> 个文件有变更</span></div>
            <div v-if="turn.state === 'failed' && turn.failureReason" class="evidence-item failed"><CircleAlert :size="15" /><span>{{ turn.failureReason }}</span></div>
          </section>

          <ChangeReviewCard
            v-if="workspaceId && turn.runId && turn.changePaths.length"
            :workspace-id="workspaceId"
            :run-id="turn.runId"
            :paths="turn.changePaths"
            @reverted="$emit('reverted', $event)"
            @review="$emit('review', $event)"
          />

          <details v-if="turn.hasActivity" class="work-record">
            <summary>
              <Activity :size="15" />
              <span>工作记录</span>
              <small>{{ turn.allToolCalls.length }} 项操作</small>
              <ChevronDown :size="14" />
            </summary>
            <div class="work-record__body">
              <ToolCallGroup v-if="turn.allToolCalls.length" :calls="turn.allToolCalls" />
              <ActivityDetails :step="turn.aggregatedStep" :hide-evidence="true" />
              <ThinkingPanel v-if="turn.thinkingText" :text="turn.thinkingText" :completed="turn.state !== 'running'" />
            </div>
          </details>

          <button v-if="turn.state === 'interrupted'" class="continue-button" type="button" @click="$emit('continue', turn.runId)">
            <Play :size="14" />继续执行
          </button>
        </div>
      </div>
    </article>
  </section>
</template>
