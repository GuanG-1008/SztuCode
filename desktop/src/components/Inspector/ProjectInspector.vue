<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  BookOpen, Check, ChevronDown, Circle, ExternalLink, FileCode2, FileText, Globe2,
  ListChecks, LoaderCircle, Maximize2, Minimize2, PackageOpen, PanelRightClose,
  Plus, RefreshCw, RotateCw, Send, SquareTerminal, X,
} from "@lucide/vue";
import {
  changeDiff, listChanges, readFile,
  type ChangeSummary,
} from "../../services/sztu-runtime";
import CodePreview from "./CodePreview.vue";
import type { TimelineStep } from "../timeline/types";

const SandboxTerminal = defineAsyncComponent(() => import("./SandboxTerminal.vue"));

const props = defineProps<{
  workspaceId: string;
  runId?: string | null;
  steps?: TimelineStep[];
  attachments?: string[];
  workspaceName?: string;
  workspacePath?: string;
}>();

const emit = defineEmits<{ close: [] }>();

type SectionKey = "todo" | "artifacts" | "references";
type BrowserTab = { id: number; label: string; input: string; url: string; frameKey: number; loading: boolean };
type ActiveTab = "summary" | `sandbox-${number}` | `browser-${number}` | "";
type WorkspaceTab = { key: ActiveTab; kind: "summary" | "browser" | "sandbox" };
type Artifact = { path: string; source: "change" | "attachment"; change?: ChangeSummary; previewPath?: string };

const activeTab = ref<ActiveTab>("summary");
const browserSequence = ref(0);
const sandboxSequence = ref(0);
const browserTabs = ref<BrowserTab[]>([]);
const workspaceTabs = ref<WorkspaceTab[]>([{ key: "summary", kind: "summary" }]);
const openSections = ref<Set<SectionKey>>(new Set(["todo", "artifacts", "references"]));
const changes = ref<ChangeSummary[]>([]);
const loadingArtifacts = ref(false);
const notice = ref("");
const selectedPath = ref("");
const preview = ref("");
const previewEncoding = ref("UTF-8");
const previewBinary = ref(false);
const previewTruncated = ref(false);
const previewMediaBase64 = ref<string | null>(null);
const previewMimeType = ref<string | null>(null);
const previewLanguage = ref("");
const expandedPanel = ref(false);
const toolMenuOpen = ref(false);
const toolMenuRoot = ref<HTMLElement | null>(null);

const plan = computed(() => [...(props.steps ?? [])].reverse().find((step) => step.plan?.length)?.plan ?? []);
const completed = computed(() => plan.value.filter((item) => item.status === "completed").length);
const progress = computed(() => plan.value.length ? Math.round((completed.value / plan.value.length) * 100) : 0);
const selectedName = computed(() => selectedPath.value.split(/[\\/]/).filter(Boolean).pop() ?? selectedPath.value);
const usedSkills = computed(() => {
  const skills = (props.steps ?? []).flatMap((step) => step.skills ?? []);
  return [...new Map(skills.map((skill) => [skill.name, skill])).values()];
});

const artifacts = computed<Artifact[]>(() => {
  const items: Artifact[] = changes.value.map((change) => ({
    path: change.path,
    previewPath: change.path,
    source: "change",
    change,
  }));
  for (const attachment of props.attachments ?? []) {
    const normalized = attachment.replace(/\\/g, "/");
    const workspace = props.workspacePath?.replace(/\\/g, "/").replace(/\/$/, "");
    const previewPath = workspace && normalized.toLowerCase().startsWith(`${workspace.toLowerCase()}/`)
      ? normalized.slice(workspace.length + 1)
      : /^[a-z]:\//i.test(normalized) ? undefined : normalized;
    items.push({ path: attachment, previewPath, source: "attachment" });
  }
  return [...new Map(items.map((item) => [item.path.toLowerCase(), item])).values()];
});

const currentBrowser = computed(() => {
  if (!activeTab.value.startsWith("browser-")) return null;
  const id = Number(activeTab.value.slice(8));
  return browserTabs.value.find((tab) => tab.id === id) ?? null;
});
const sandboxTabs = computed(() => workspaceTabs.value.filter((tab) => tab.kind === "sandbox"));

function basename(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function toggleSection(section: SectionKey) {
  const next = new Set(openSections.value);
  if (next.has(section)) next.delete(section);
  else next.add(section);
  openSections.value = next;
}

function activateBrowser(id: number) {
  activeTab.value = `browser-${id}`;
  selectedPath.value = "";
}

function createBrowserTab() {
  const id = ++browserSequence.value;
  const key = `browser-${id}` as const;
  browserTabs.value.push({ id, label: "新标签页", input: "", url: "", frameKey: 0, loading: false });
  workspaceTabs.value.push({ key, kind: "browser" });
  activateBrowser(id);
  toolMenuOpen.value = false;
}

function closeWorkspaceTab(key: ActiveTab) {
  if (!key) return;
  const index = workspaceTabs.value.findIndex((tab) => tab.key === key);
  if (key.startsWith("browser-")) {
    const id = Number(key.slice(8));
    browserTabs.value = browserTabs.value.filter((tab) => tab.id !== id);
  }
  workspaceTabs.value = workspaceTabs.value.filter((tab) => tab.key !== key);
  if (activeTab.value !== key) return;
  const fallback = workspaceTabs.value[Math.min(index, workspaceTabs.value.length - 1)] ?? workspaceTabs.value[0];
  activeTab.value = fallback?.key ?? "";
  selectedPath.value = "";
}

function browserForKey(key: ActiveTab) {
  if (!key.startsWith("browser-")) return null;
  return browserTabs.value.find((tab) => tab.id === Number(key.slice(8))) ?? null;
}

function openSummary() {
  if (!workspaceTabs.value.some((tab) => tab.kind === "summary")) workspaceTabs.value.push({ key: "summary", kind: "summary" });
  activeTab.value = "summary";
  selectedPath.value = "";
  toolMenuOpen.value = false;
}

function openBrowser() {
  const tab = browserTabs.value[0];
  if (tab) {
    activateBrowser(tab.id);
    toolMenuOpen.value = false;
  } else createBrowserTab();
}

function openTerminal() {
  const id = ++sandboxSequence.value;
  const key = `sandbox-${id}` as const;
  workspaceTabs.value.push({ key, kind: "sandbox" });
  activeTab.value = key;
  selectedPath.value = "";
  toolMenuOpen.value = false;
}

function sandboxLabel(key: ActiveTab) {
  if (!key.startsWith("sandbox-")) return "沙盒";
  const id = Number(key.slice(8));
  return id > 1 ? `沙盒 ${id}` : "沙盒";
}

function normalizedUrl(value: string) {
  const input = value.trim();
  if (!input) return "";
  return /^[a-z][a-z\d+.-]*:\/\//i.test(input) ? input : `https://${input}`;
}

function navigateBrowser(tab: BrowserTab) {
  const url = normalizedUrl(tab.input);
  if (!url) return;
  try {
    const parsed = new URL(url);
    tab.url = parsed.toString();
    tab.input = tab.url;
    tab.label = parsed.hostname.replace(/^www\./, "") || "新标签页";
    tab.loading = true;
    tab.frameKey += 1;
  } catch {
    notice.value = "请输入有效的网址";
  }
}

function reloadBrowser(tab: BrowserTab) {
  if (!tab.url) return;
  tab.loading = true;
  tab.frameKey += 1;
}

async function refreshArtifacts() {
  loadingArtifacts.value = true;
  notice.value = "";
  try {
    changes.value = await listChanges(props.workspaceId, props.runId);
  } catch (error) {
    notice.value = error instanceof Error ? error.message : String(error);
  } finally {
    loadingArtifacts.value = false;
  }
}

async function openArtifact(artifact: Artifact) {
  if (!artifact.previewPath) {
    notice.value = "该附件不在当前项目内，暂不支持直接预览";
    return;
  }
  selectedPath.value = artifact.path;
  preview.value = "";
  previewLanguage.value = artifact.change ? "diff" : "";
  previewEncoding.value = "UTF-8";
  previewBinary.value = false;
  previewTruncated.value = false;
  previewMediaBase64.value = null;
  previewMimeType.value = null;
  notice.value = "";
  try {
    if (artifact.change) {
      preview.value = await changeDiff(props.workspaceId, artifact.previewPath);
    } else {
      const result = await readFile(props.workspaceId, artifact.previewPath);
      preview.value = result.content;
      previewEncoding.value = result.encoding;
      previewBinary.value = result.binary;
      previewTruncated.value = result.truncated;
      previewMediaBase64.value = result.media_base64 ?? null;
      previewMimeType.value = result.mime_type ?? null;
    }
  } catch (error) {
    notice.value = error instanceof Error ? error.message : String(error);
  }
}

function closeToolMenu(event: PointerEvent) {
  if (toolMenuOpen.value && !toolMenuRoot.value?.contains(event.target as Node)) toolMenuOpen.value = false;
}

function closeToolMenuOnEscape(event: KeyboardEvent) {
  if (event.key === "Escape") toolMenuOpen.value = false;
}

watch(() => [props.workspaceId, props.runId], () => {
  activeTab.value = "summary";
  browserSequence.value = 0;
  sandboxSequence.value = 0;
  browserTabs.value = [];
  workspaceTabs.value = [{ key: "summary", kind: "summary" }];
  selectedPath.value = "";
  void refreshArtifacts();
}, { immediate: true });

onMounted(() => {
  document.addEventListener("pointerdown", closeToolMenu);
  document.addEventListener("keydown", closeToolMenuOnEscape);
});
onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", closeToolMenu);
  document.removeEventListener("keydown", closeToolMenuOnEscape);
});
</script>

<template>
  <aside class="project-inspector file-rail" :class="{ 'is-expanded': expandedPanel }">
    <header class="workspace-tab-strip">
      <div ref="toolMenuRoot" class="workspace-tool-menu-root">
        <button type="button" class="workspace-tool-menu-trigger" :class="{ active: toolMenuOpen }" aria-label="打开功能" aria-haspopup="menu" :aria-expanded="toolMenuOpen" @click="toolMenuOpen = !toolMenuOpen"><Plus :size="16" /></button>
        <nav v-if="toolMenuOpen" class="workspace-tool-menu" aria-label="选择功能" role="menu">
          <button type="button" role="menuitem" :class="{ active: activeTab === 'summary' }" @click="openSummary"><ListChecks :size="15" /><span>任务摘要</span></button>
          <button type="button" role="menuitem" :class="{ active: currentBrowser }" @click="openBrowser"><Globe2 :size="15" /><span>浏览器</span></button>
          <button type="button" role="menuitem" :class="{ active: activeTab.startsWith('sandbox-') }" @click="openTerminal"><SquareTerminal :size="15" /><span>终端</span></button>
        </nav>
      </div>
      <nav class="workspace-open-tabs" aria-label="已打开功能">
        <div v-for="tab in workspaceTabs" :key="tab.key" class="workspace-open-tab" :class="{ active: activeTab === tab.key }">
          <button type="button" :aria-pressed="activeTab === tab.key" @click="activeTab = tab.key">
            <span class="workspace-tab-icon">
              <ListChecks v-if="tab.kind === 'summary'" class="workspace-tab-kind-icon" :size="14" />
              <Globe2 v-else-if="tab.kind === 'browser'" class="workspace-tab-kind-icon" :size="14" />
              <SquareTerminal v-else class="workspace-tab-kind-icon" :size="14" />
            </span>
            <span>{{ tab.kind === 'summary' ? '任务摘要' : tab.kind === 'sandbox' ? sandboxLabel(tab.key) : (browserForKey(tab.key)?.label ?? '新标签页') }}</span>
          </button>
          <button type="button" class="workspace-tab-close" :aria-label="`关闭${tab.kind === 'summary' ? '任务摘要' : tab.kind === 'sandbox' ? sandboxLabel(tab.key) : (browserForKey(tab.key)?.label ?? '新标签页')}`" @click.stop="closeWorkspaceTab(tab.key)"><X :size="12" /></button>
        </div>
      </nav>
      <button type="button" class="workspace-browser-add" aria-label="新建浏览器标签页" @click="createBrowserTab"><Plus :size="16" /></button>
      <span class="workspace-header-divider" />
      <button type="button" class="workspace-expand" :aria-label="expandedPanel ? '还原功能区' : '展开功能区'" @click="expandedPanel = !expandedPanel"><Minimize2 v-if="expandedPanel" :size="15" /><Maximize2 v-else :size="15" /></button>
      <button type="button" class="workspace-panel-close" aria-label="退出分屏布局" @click="emit('close')"><PanelRightClose :size="16" /></button>
    </header>

    <main v-if="activeTab === 'summary'" class="task-summary-view">
      <section class="summary-section" :class="{ collapsed: !openSections.has('todo') }">
        <button type="button" class="summary-section-trigger" :aria-expanded="openSections.has('todo')" @click="toggleSection('todo')">
          <b>待办</b><ChevronDown :size="13" /><small v-if="plan.length">{{ completed }}/{{ plan.length }}</small>
        </button>
        <div v-if="openSections.has('todo')" class="summary-section-body todo-section-body">
          <template v-if="plan.length">
            <div class="summary-progress"><i :style="{ width: progress + '%' }" /></div>
            <ol class="summary-plan-list">
              <li v-for="item in plan" :key="item.id" :class="item.status">
                <span><Check v-if="item.status === 'completed'" :size="11" /><LoaderCircle v-else-if="item.status === 'in_progress'" :size="12" /><Circle v-else :size="9" /></span>
                <p>{{ item.subject }}</p>
              </li>
            </ol>
          </template>
          <div v-else class="summary-empty">
            <span class="summary-empty-icon"><ListChecks :size="15" /></span>
            <b>暂无待办</b>
            <p>复杂任务的进展会显示在这里</p>
          </div>
        </div>
      </section>

      <section class="summary-section" :class="{ collapsed: !openSections.has('artifacts') }">
        <button type="button" class="summary-section-trigger" :aria-expanded="openSections.has('artifacts')" @click="toggleSection('artifacts')">
          <b>任务产物</b><ChevronDown :size="13" /><small v-if="artifacts.length">{{ artifacts.length }} 项</small>
        </button>
        <div v-if="openSections.has('artifacts')" class="summary-section-body">
          <div v-if="artifacts.length" class="artifact-list">
            <button v-for="artifact in artifacts" :key="artifact.path" type="button" :title="artifact.path" @click="openArtifact(artifact)">
              <span><FileCode2 v-if="artifact.source === 'change'" :size="15" /><FileText v-else :size="15" /></span>
              <span><b>{{ basename(artifact.path) }}</b><small>{{ artifact.source === 'change' ? '代码变更' : '任务附件' }}</small></span>
              <code v-if="artifact.change">{{ artifact.change.index_status }}{{ artifact.change.worktree_status }}</code>
              <ExternalLink v-else :size="13" />
            </button>
          </div>
          <div v-else class="summary-empty">
            <span class="summary-empty-icon"><PackageOpen :size="15" /></span>
            <b>暂无产物</b>
            <p>任务完成后，生成的文件将展示在这里</p>
          </div>
          <button v-if="artifacts.length" type="button" class="summary-refresh" :disabled="loadingArtifacts" @click="refreshArtifacts"><RefreshCw :size="13" :class="{ spin: loadingArtifacts }" />刷新产物</button>
        </div>
      </section>

      <section class="summary-section" :class="{ collapsed: !openSections.has('references') }">
        <button type="button" class="summary-section-trigger" :aria-expanded="openSections.has('references')" @click="toggleSection('references')">
          <b>参考信息</b><ChevronDown :size="13" />
        </button>
        <div v-if="openSections.has('references')" class="summary-section-body reference-body">
          <div class="reference-row">
            <span>技能</span>
            <div v-if="usedSkills.length" class="skill-list"><span v-for="skill in usedSkills" :key="skill.name"><BookOpen :size="14" />{{ skill.name }}</span></div>
            <small v-else>本轮任务暂未加载技能</small>
          </div>
          <div class="reference-context">
            <span>上下文</span>
            <p><b>{{ workspaceName || '当前项目' }}</b><small :title="workspacePath">{{ workspacePath }}</small></p>
            <p v-if="attachments?.length || changes.length"><b>{{ (attachments?.length ?? 0) + changes.length }} 项关联内容</b><small>{{ attachments?.length ?? 0 }} 个附件 · {{ changes.length }} 个文件变更</small></p>
          </div>
        </div>
      </section>
    </main>

    <main v-else-if="currentBrowser" class="browser-workspace">
      <form class="browser-toolbar" @submit.prevent="navigateBrowser(currentBrowser)">
        <button type="button" title="刷新网页" aria-label="刷新网页" :disabled="!currentBrowser.url" @click="reloadBrowser(currentBrowser)"><RotateCw :size="14" /></button>
        <label><Globe2 :size="14" /><input v-model="currentBrowser.input" aria-label="网页地址" placeholder="输入网址" spellcheck="false" /></label>
        <button type="submit" title="访问" aria-label="访问网页"><Send :size="14" /></button>
      </form>
      <div class="browser-stage">
        <iframe v-if="currentBrowser.url" :key="currentBrowser.frameKey" :src="currentBrowser.url" :title="currentBrowser.label" @load="currentBrowser.loading = false" />
        <div v-else class="browser-empty"><Globe2 :size="28" /><p>暂无网页预览，让AI生成一些内容看看吧！</p></div>
        <div v-if="currentBrowser.loading" class="browser-loading"><LoaderCircle :size="20" /><span>正在载入网页</span></div>
        <p v-if="currentBrowser.url && !currentBrowser.loading" class="browser-frame-note">页面空白时，可能是网站限制嵌入预览</p>
      </div>
    </main>

    <main v-for="tab in sandboxTabs" v-show="activeTab === tab.key" :key="`${workspacePath}-${tab.key}`" class="sandbox-workspace"><SandboxTerminal :workspace-path="workspacePath || ''" /></main>
    <main v-if="!activeTab" class="workspace-empty-view" />

    <section v-if="selectedPath" class="file-preview file-preview--flyout">
      <header><span class="preview-tab"><FileText :size="15" /><b>{{ selectedName }}</b><i /></span><button title="关闭预览" @click="selectedPath = ''; preview = ''"><X :size="17" /></button></header>
      <CodePreview :content="preview" :path="selectedPath" :encoding="previewEncoding" :binary="previewBinary" :truncated="previewTruncated" :force-language="previewLanguage" :media-base64="previewMediaBase64" :mime-type="previewMimeType" />
    </section>
    <p v-if="notice" class="inspector-notice"><span>{{ notice }}</span><button type="button" aria-label="关闭提示" @click="notice = ''"><X :size="13" /></button></p>
  </aside>
</template>
