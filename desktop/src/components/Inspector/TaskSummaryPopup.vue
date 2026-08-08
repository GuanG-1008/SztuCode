<script setup lang="ts">
// 会话区右上角的小浮窗：展示任务待办进度、产物数量与项目上下文，整体缩小
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Check, ChevronRight, Circle, FileDiff, Gauge, ListChecks, LoaderCircle, PackageOpen } from "@lucide/vue";
import { listChanges, type ChangeSummary } from "../../services/sztu-runtime";
import type { TimelineStep } from "../timeline/types";

const props = defineProps<{
  workspaceId?: string | null;
  runId?: string | null;
  steps?: TimelineStep[];
  attachments?: string[];
  workspaceName?: string;
  workspacePath?: string;
}>();

// 点击产物时通知上层打开 DiffReview 审核窗口（App 中 handleReview → page=diff）
const emit = defineEmits<{ review: [ctx: { workspaceId: string; runId: string; paths: string[] }] }>();

const open = ref(false);
const changes = ref<ChangeSummary[]>([]);
const loading = ref(false);
const rootEl = ref<HTMLElement | null>(null);

// 最后一个含计划步骤的 plan 作为当前待办计划
const plan = computed(() => [...(props.steps ?? [])].reverse().find((step) => step.plan?.length)?.plan ?? []);
const completed = computed(() => plan.value.filter((item) => item.status === "completed").length);
const progress = computed(() => (plan.value.length ? Math.round((completed.value / plan.value.length) * 100) : 0));
// 待办列表最多展示前 12 条，适配放大后的浮窗
const visiblePlan = computed(() => plan.value.slice(0, 12));
const contextUsage = computed(() => [...(props.steps ?? [])].reverse().find((step) => step.usage)?.usage);
const formatTokens = (value: number) => value >= 1000 ? `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k` : String(value);
const contextPercent = computed(() => Math.min(100, Math.round((contextUsage.value?.contextPct ?? 0) * 100)));
const contextSegments = computed(() => {
  const usage = contextUsage.value;
  if (!usage?.contextWindow) return [];
  return [
    { key: "system", label: "系统指令", value: usage.systemTokens },
    { key: "summary", label: "历史摘要", value: usage.summaryTokens },
    { key: "conversation", label: "近期对话", value: usage.conversationTokens },
    { key: "tools", label: "工具与结果", value: usage.toolTokens },
    { key: "reserved", label: "输出预留", value: usage.reservedOutputTokens },
  ].filter((item) => item.value > 0).map((item) => ({ ...item, width: `${Math.max(.8, item.value / usage.contextWindow * 100)}%` }));
});

// 已用技能聚合去重
const usedSkills = computed(() => [...new Map((props.steps ?? []).flatMap((step) => step.skills ?? []).map((skill) => [skill.name, skill])).values()]);

// 拉取当前 run 的变更文件列表，用于产物计数
async function loadChanges() {
  if (!props.workspaceId) { changes.value = []; return; }
  loading.value = true;
  try { changes.value = await listChanges(props.workspaceId, props.runId); }
  catch { changes.value = []; }
  finally { loading.value = false; }
}

// 打开浮窗时刷新产物计数
async function toggle() {
  open.value = !open.value;
  if (open.value && props.workspaceId) await loadChanges();
}

// 产物列表默认展示前 8 条，可展开查看全部
const showAllChanges = ref(false);
const visibleChanges = computed(() =>
  showAllChanges.value ? changes.value : changes.value.slice(0, 8),
);

// 点击产物行：将全部变更文件交给上层 DiffReview 打开审核窗口
function openAllChanges() {
  if (!props.workspaceId || !props.runId || !changes.value.length) return;
  emit("review", {
    workspaceId: props.workspaceId,
    runId: props.runId,
    paths: changes.value.map((change) => change.path),
  });
}

// 点击单个变更文件：仅针对该文件打开 diff 审核
function openChange(change: ChangeSummary) {
  if (!props.workspaceId || !props.runId) return;
  emit("review", { workspaceId: props.workspaceId, runId: props.runId, paths: [change.path] });
}

// 点击浮窗外部关闭
function onPointerDown(event: PointerEvent) {
  if (!open.value || !rootEl.value) return;
  if (!rootEl.value.contains(event.target as Node)) open.value = false;
}
// Esc 关闭浮窗
function onKeyDown(event: KeyboardEvent) {
  if (event.key === "Escape" && open.value) open.value = false;
}

// 会话或工作区切换时重置浮窗状态并预加载产物
watch(
  () => [props.workspaceId, props.runId],
  () => { open.value = false; void loadChanges(); },
);

onMounted(() => {
  document.addEventListener("pointerdown", onPointerDown);
  document.addEventListener("keydown", onKeyDown);
  void loadChanges();
});
onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", onPointerDown);
  document.removeEventListener("keydown", onKeyDown);
});
</script>

<template>
  <div ref="rootEl" class="task-summary-popup" :class="{ open }">
    <button
      type="button"
      class="task-summary-popup__trigger"
      title="任务摘要"
      aria-label="任务摘要"
      :aria-expanded="open"
      @click="toggle"
    >
      <ListChecks :size="16" />
      <span v-if="plan.length" class="task-summary-popup__badge">{{ progress }}%</span>
    </button>

    <section v-if="open" class="task-summary-popup__panel" role="dialog" aria-label="任务摘要">
      <header class="task-summary-popup__head">
        <b>任务摘要</b>
        <small v-if="workspaceName">{{ workspaceName }}</small>
      </header>

      <div v-if="contextUsage?.contextWindow" class="task-summary-popup__row task-summary-popup__context">
        <div class="task-summary-popup__label">
          <span><Gauge :size="12" />上下文空间</span>
          <em :class="{ warning: contextPercent >= 80 }">已用 {{ contextPercent }}%</em>
        </div>
        <div class="context-meter" :aria-label="`上下文已用 ${contextPercent}%`">
          <i v-for="segment in contextSegments" :key="segment.key" :class="`context-meter__${segment.key}`" :style="{ width: segment.width }" />
        </div>
        <div class="context-available">
          <strong>{{ formatTokens(contextUsage.availableTokens) }}</strong>
          <span>尚可使用</span>
          <small>共 {{ formatTokens(contextUsage.contextWindow) }} tokens</small>
        </div>
        <ul class="context-breakdown">
          <li v-for="segment in contextSegments" :key="segment.key" :class="`context-breakdown__${segment.key}`">
            <i /><span>{{ segment.label }}</span><b>{{ formatTokens(segment.value) }}</b>
          </li>
        </ul>
        <p v-if="contextUsage.compacting" class="context-compaction active">正在自动压缩较早上下文…</p>
        <p v-else-if="contextUsage.compactedTokens" class="context-compaction">最近一次压缩释放 {{ formatTokens(contextUsage.compactedTokens) }} tokens</p>
      </div>

      <div v-if="plan.length" class="task-summary-popup__row">
        <div class="task-summary-popup__label">待办进度</div>
        <div class="task-summary-popup__progress">
          <span class="task-summary-popup__progress-bar"><i :style="{ width: progress + '%' }" /></span>
          <em>{{ completed }}/{{ plan.length }} · {{ progress }}%</em>
        </div>
        <ul class="task-summary-popup__plan">
          <li v-for="item in visiblePlan" :key="item.id" :class="'task-summary-popup__plan-' + item.status">
            <Check v-if="item.status === 'completed'" :size="11" />
            <LoaderCircle v-else-if="item.status === 'in_progress'" class="spin" :size="11" />
            <Circle v-else :size="11" />
            <span>{{ item.subject }}</span>
          </li>
          <li v-if="plan.length > visiblePlan.length" class="task-summary-popup__plan-more">另有 {{ plan.length - visiblePlan.length }} 项待办…</li>
        </ul>
      </div>
      <p v-else class="task-summary-popup__empty">暂无计划，等待任务开始。</p>

      <div class="task-summary-popup__row">
        <div class="task-summary-popup__label">
          <span>任务产物</span>
          <button
            v-if="changes.length"
            type="button"
            class="task-summary-popup__open"
            title="打开全部文件 Diff 审核"
            @click="openAllChanges"
          >
            <FileDiff :size="12" />查看全部变更 <ChevronRight :size="11" />
          </button>
        </div>
        <div class="task-summary-popup__meta">
          <PackageOpen :size="12" />
          <span v-if="loading">加载中…</span>
          <span v-else>文件变更 {{ changes.length }} · 附件 {{ attachments?.length ?? 0 }}</span>
        </div>
        <ul v-if="visibleChanges.length" class="task-summary-popup__files">
          <li v-for="change in visibleChanges" :key="change.path">
            <button type="button" :title="change.path" @click="openChange(change)">
              <span>{{ change.path }}</span>
              <em v-if="change.additions != null || change.deletions != null">
                +{{ change.additions ?? 0 }}/−{{ change.deletions ?? 0 }}
              </em>
            </button>
          </li>
          <li v-if="!showAllChanges && changes.length > visibleChanges.length" class="task-summary-popup__files-more">
            <button type="button" @click="showAllChanges = true">展开其余 {{ changes.length - visibleChanges.length }} 个文件</button>
          </li>
        </ul>
      </div>

      <div v-if="usedSkills.length || workspacePath" class="task-summary-popup__row">
        <div class="task-summary-popup__label">参考信息</div>
        <div class="task-summary-popup__meta">
          <span v-if="workspacePath" class="task-summary-popup__path" :title="workspacePath">{{ workspacePath }}</span>
          <span v-if="usedSkills.length">已用技能 {{ usedSkills.length }} 项</span>
        </div>
      </div>
    </section>
  </div>
</template>
