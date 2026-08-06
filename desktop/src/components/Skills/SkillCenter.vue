<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import {
  Bot, Check, ChevronDown, CirclePlus, Code2, Database, FileText, Image,
  Link2, PackageCheck, Plus, RefreshCw, Search, Sparkles, Star,
  WandSparkles, X,
} from "@lucide/vue";
import { BUILT_IN_SKILLS } from "../CommandPalette/slash-menu";

type LocalSkill = { name: string; description: string; avatar_url?: string | null };
type HubSkill = {
  id: string; skillId: string; name: string; source: string; installs: number;
  description?: string; avatar_url?: string | null;
};
type SkillItem = LocalSkill & { source: "local" | "hub"; id: string; installs: number; category: string; tone: string };

const props = defineProps<{ skills: LocalSkill[]; connected: boolean }>();
const activeArea = ref<"experts" | "skills" | "connectors">("skills");
const activeCollection = ref<"recommended" | "hub" | "bundles">("recommended");
const activeCategory = ref("全部");
const query = ref("");
const installedOnly = ref(false);
const featuredOffset = ref(0);
const addDialogOpen = ref(false);
const customSkillName = ref("");
const customSkillSource = ref("");
const customSkills = ref<LocalSkill[]>([]);
const hubSkills = ref<HubSkill[]>([]);
const hubLoading = ref(false);
const hubError = ref("");
const hubQueried = ref("");
const defaultInstalled = ["frontend-design", "find-skills", "review-agent", "documents", "presentations", "imagegen", "visualize", "openai-docs"];
const storedInstalled = localStorage.getItem("sztu.installedSkills");
let persistedInstalled: string[] = defaultInstalled;
try {
  const parsed = storedInstalled ? JSON.parse(storedInstalled) : null;
  if (Array.isArray(parsed) && parsed.every((value) => typeof value === "string")) persistedInstalled = parsed;
} catch { /* Ignore malformed state from an older build. */ }
const installed = ref(new Set<string>(persistedInstalled));

const curatedSkills: LocalSkill[] = [
  { name: "公众号爆款封面设计", description: "基于全网每日收录的10w+爆文元数据，分析同类封面视觉元素，AI生成高转化封面设计方案" },
  { name: "腾讯微云", description: "管理腾讯微云网盘文件（列表、上传、下载、删除、分享）" },
  { name: "腾讯问卷", description: "腾讯问卷操作（创建、修改、逻辑设置、统计）" },
  { name: "鹅厂辩证助手", description: "面向腾讯相关性的辩证辅助 Skill，结合内部参考与实时联网核查，给出结论、事实依据和防护提醒" },
  { name: "NeoData金融搜索服务", description: "自然语言查询股票、基金、宏观、外汇、大宗商品等金融数据" },
  { name: "东方财富妙想金融数据", description: "基于东方财富数据库，支持自然语言查询金融数据，覆盖A港美、基金、债券等多种资产" },
  { name: "东方财富妙想市场搜索", description: "基于东方财富数据库，支持自然语言搜索全网最新公告、研报、财经新闻和市场动态" },
  { name: "战略洞察生成器", description: "基于财报分析生成3-5条核心战略洞察，重点关注经营业务相关高频词和组织架构变化" },
  { name: "MarkItDown", description: "文档转 Markdown（PDF/Word/PPT/图片OCR/音频转写/网页）" },
  { name: "抖音热榜", description: "获取抖音实时热榜TOP50，支持历史回溯与定时推送" },
  { name: "QQ音乐助手", description: "QQ音乐官方智能助手，支持歌曲搜索、每日推荐、AI歌单、排行榜和听歌报告" },
  { name: "财报文字数据提取器", description: "自动识别并提取股份制银行财报中的文字描述和核心指标" },
  { name: "Web Access（浏览器自动化）", description: "CDP直连本地 Chrome，智能调度联网工具，支持登录态与并行批量操作" },
  { name: "腾讯自选股-金融数据查询", description: "由腾讯自选股团队提供，查询A股、港股、美股个股、指数和ETF的详细数据" },
  { name: "PDF图片文字提取", description: "从图片或PDF中识别提取文字，保留原始格式输出结构化结果" },
  { name: "fbs-bookwriter", description: "福帮手出品，高质量长文档手稿工具链：书籍、手册、白皮书、行业指南、长篇报道" },
  { name: "技能创建指南", description: "创建和维护自定义技能的指南" },
  { name: "Excel 文件处理", description: "Excel 文件创建与分析" },
  { name: "创业可以学", description: "服务创业者和管理者，解答创业、商业和管理问题，引发深度思考" },
  { name: "平安证券资讯查询", description: "投股票、公司、行业、ETF、概念或市场主题检索相关新闻、快讯和财经报道" },
  { name: "同花顺iFinD金融数据查询", description: "同花顺iFinD金融数据查询，覆盖股票、基金、宏观经济、行业经济和新闻公告" },
  { name: "A股全数数据", description: "A股行情、研报、资金流、公告与财报查询工具包" },
  { name: "Word 文档生成", description: "Word 文档生成与编辑" },
  { name: "股份制银行财报数据分析", description: "基于Skill和数据接口获取的银行财报数据，进行经营分析与对比" },
];

const metadata: Record<string, { category: string; tone: string }> = {
  "frontend-design": { category: "设计多媒体", tone: "graphite" }, "find-skills": { category: "AI Agent", tone: "lime" },
  "review-agent": { category: "开发编程", tone: "coral" }, documents: { category: "办公效率", tone: "blue" },
  presentations: { category: "办公效率", tone: "amber" }, spreadsheets: { category: "数据分析", tone: "green" },
  pdf: { category: "内容创作", tone: "olive" }, imagegen: { category: "设计多媒体", tone: "rose" },
  visualize: { category: "数据分析", tone: "cyan" }, "openai-docs": { category: "知识管理", tone: "black" },
  "skill-creator": { category: "开发编程", tone: "violet" }, "plugin-creator": { category: "开发编程", tone: "orange" },
};

const categories = ["全部", "办公效率", "内容创作", "开发编程", "数据分析", "设计多媒体", "AI Agent", "知识管理"];
const initials = (name: string) => name.split(/[-_\s/]+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "S";
const avatarFor = (skill: SkillItem | HubSkill) => {
  if (skill.avatar_url) return skill.avatar_url;
  if (!("source" in skill) || skill.source === "local") return "";
  const source = skill.source;
  const owner = source.split("/")[0];
  return owner ? `https://github.com/${owner}.png?size=96` : "";
};
const fallbackTone = (name: string) => ["graphite", "green", "amber", "blue", "violet"][name.length % 5];
const categoryFor = (name: string) => metadata[name.toLowerCase()]?.category ?? "AI Agent";

const localSkills = computed<SkillItem[]>(() => {
  const merged = new Map<string, SkillItem>();
  for (const skill of curatedSkills) merged.set(skill.name.toLowerCase(), { ...skill, id: skill.name, source: "local", installs: 0, category: categoryFor(skill.name), tone: metadata[skill.name]?.tone ?? fallbackTone(skill.name) });
  for (const skill of BUILT_IN_SKILLS) merged.set(skill.name.toLowerCase(), { ...skill, id: skill.name, source: "local", installs: 0, category: categoryFor(skill.name), tone: metadata[skill.name]?.tone ?? fallbackTone(skill.name) });
  for (const skill of props.skills) merged.set(skill.name.toLowerCase(), { ...skill, id: skill.name, source: "local", installs: 0, category: categoryFor(skill.name), tone: metadata[skill.name]?.tone ?? fallbackTone(skill.name) });
  for (const skill of customSkills.value) merged.set(skill.name.toLowerCase(), { ...skill, id: skill.name, source: "local", installs: 0, category: categoryFor(skill.name), tone: metadata[skill.name]?.tone ?? fallbackTone(skill.name) });
  return [...merged.values()];
});
const remoteSkills = computed<SkillItem[]>(() => hubSkills.value.map((skill) => ({
  name: skill.name || skill.skillId, description: skill.description || `来自 ${skill.source} 的社区技能`, id: skill.id,
  source: "hub", installs: skill.installs || 0, category: categoryFor(skill.name || skill.skillId), tone: fallbackTone(skill.name || skill.skillId), avatar_url: skill.avatar_url,
})));
const allSkills = computed(() => {
  const map = new Map(localSkills.value.map((skill) => [skill.name.toLowerCase(), skill]));
  for (const skill of remoteSkills.value) if (!map.has(skill.name.toLowerCase())) map.set(skill.name.toLowerCase(), skill);
  return [...map.values()];
});
const featured = computed(() => (allSkills.value.length ? Array.from({ length: Math.min(4, allSkills.value.length) }, (_, i) => allSkills.value[(featuredOffset.value + i) % allSkills.value.length]) : []));
const filteredSkills = computed(() => {
  const value = query.value.trim().toLowerCase();
  return allSkills.value.filter((skill) => (activeCategory.value === "全部" || skill.category === activeCategory.value) && (!installedOnly.value || installed.value.has(skill.name)) && (!value || `${skill.name} ${skill.description} ${skill.category}`.toLowerCase().includes(value)));
});
const installedCount = computed(() => [...installed.value].filter((name) => allSkills.value.some((skill) => skill.name === name)).length);

async function searchHub(term = query.value) {
  const value = term.trim();
  if (!value) { hubSkills.value = []; hubError.value = ""; hubQueried.value = ""; return; }
  hubLoading.value = true; hubError.value = ""; hubQueried.value = value;
  try {
    const response = await fetch(`https://skills.sh/api/search?q=${encodeURIComponent(value)}`, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`SkillHub 返回 ${response.status}`);
    const data = await response.json() as { skills?: HubSkill[] };
    hubSkills.value = (data.skills ?? []).slice(0, 60);
  } catch (error) {
    hubSkills.value = [];
    hubError.value = error instanceof Error ? error.message : "SkillHub 暂时不可用";
  } finally { hubLoading.value = false; }
}
let searchTimer: number | undefined;
watch(query, (value) => { window.clearTimeout(searchTimer); searchTimer = window.setTimeout(() => void searchHub(value), 320); });
function toggleInstalled(name: string) { const next = new Set(installed.value); next.has(name) ? next.delete(name) : next.add(name); installed.value = next; localStorage.setItem("sztu.installedSkills", JSON.stringify([...next])); }
function rotateFeatured() { featuredOffset.value = (featuredOffset.value + 4) % Math.max(1, allSkills.value.length); }
function addCustomSkill() { const name = customSkillName.value.trim(); if (!name) return; customSkills.value = [...customSkills.value, { name, description: customSkillSource.value.trim() || "本地自定义技能" }]; toggleInstalled(name); customSkillName.value = ""; customSkillSource.value = ""; addDialogOpen.value = false; }
function iconFor(skill: SkillItem) { if (skill.category === "开发编程") return Code2; if (skill.category === "数据分析") return Database; if (skill.category === "设计多媒体") return Image; if (skill.category === "办公效率" || skill.category === "内容创作") return FileText; return Sparkles; }
onMounted(() => { if (query.value) void searchHub(); });
</script>

<template>
  <section class="skill-center" aria-label="技能中心">
    <header class="skill-center__topbar">
      <nav aria-label="能力类型">
        <button :class="{ active: activeArea === 'experts' }" @click="activeArea = 'experts'"><Bot :size="16" />专家</button>
        <button :class="{ active: activeArea === 'skills' }" @click="activeArea = 'skills'"><WandSparkles :size="16" />技能</button>
        <button :class="{ active: activeArea === 'connectors' }" @click="activeArea = 'connectors'"><Link2 :size="16" />连接器</button>
      </nav>
      <div class="skill-center__actions">
        <label><Search :size="15" /><input v-model="query" :placeholder="activeArea === 'skills' ? '搜索技能' : '搜索能力'" /></label>
        <button :class="{ active: installedOnly }" @click="installedOnly = !installedOnly"><PackageCheck :size="16" />我安装的 <span>{{ installedCount }}</span></button>
        <button @click="addDialogOpen = true"><CirclePlus :size="16" />添加技能</button>
      </div>
    </header>

    <main v-if="activeArea === 'skills'" class="skill-center__body">
      <section class="hub-status" :class="{ 'hub-status--error': hubError }" aria-live="polite">
        <span class="hub-status__dot" :class="{ online: !hubError && !hubLoading, loading: hubLoading }"></span>
        <span v-if="hubLoading">正在连接 SkillHub，搜索“{{ hubQueried }}”</span><span v-else-if="hubError">SkillHub 连接失败：{{ hubError }}</span><span v-else>{{ hubQueried ? `SkillHub 已返回 ${hubSkills.length} 项结果` : 'SkillHub 社区目录 · 输入关键词开始搜索' }}</span>
        <button v-if="hubError" aria-label="重试 SkillHub" @click="searchHub()"><RefreshCw :size="13" /></button>
      </section>
      <section class="featured-skills" aria-labelledby="featured-title">
        <header><h1 id="featured-title">精选技能</h1><button @click="rotateFeatured"><RefreshCw :size="14" />换一换</button></header>
        <div><article v-for="skill in featured" :key="skill.id" class="featured-skill"><div class="skill-avatar" :data-tone="skill.tone"><img v-if="avatarFor(skill)" :src="avatarFor(skill)" :alt="`${skill.name} 头像`" loading="lazy" @error="($event.target as HTMLImageElement).style.display = 'none'" /><span>{{ initials(skill.name) }}</span></div><div><h2>{{ skill.name }}</h2><p>{{ skill.description }}</p></div><button :aria-label="`${installed.has(skill.name) ? '移除' : '添加'} ${skill.name}`" :class="{ installed: installed.has(skill.name) }" @click="toggleInstalled(skill.name)"><Check v-if="installed.has(skill.name)" :size="15" /><Plus v-else :size="16" /></button></article></div>
      </section>
      <section class="skill-catalog" aria-labelledby="catalog-title">
        <header class="skill-catalog__tabs"><button :class="{ active: activeCollection === 'recommended' }" @click="activeCollection = 'recommended'">推荐</button><button id="catalog-title" :class="{ active: activeCollection === 'hub' }" @click="activeCollection = 'hub'">SkillHub</button><button :class="{ active: activeCollection === 'bundles' }" @click="activeCollection = 'bundles'">套件</button><small>{{ connected ? '已连接本地运行时' : '离线模式' }}</small></header>
        <div class="skill-catalog__filters"><button v-for="category in categories" :key="category" :class="{ active: activeCategory === category }" @click="activeCategory = category">{{ category }}</button><button class="skill-sort">综合评分<ChevronDown :size="13" /></button></div>
        <div v-if="filteredSkills.length" class="skill-grid"><article v-for="skill in filteredSkills" :key="`${skill.source}:${skill.id}`" class="skill-card"><header><div class="skill-avatar skill-avatar--small" :data-tone="skill.tone"><img v-if="avatarFor(skill)" :src="avatarFor(skill)" :alt="`${skill.name} 头像`" loading="lazy" @error="($event.target as HTMLImageElement).style.display = 'none'" /><span>{{ initials(skill.name) }}</span></div><h2>{{ skill.name }}</h2><button :aria-label="`${installed.has(skill.name) ? '移除' : '添加'} ${skill.name}`" :class="{ installed: installed.has(skill.name) }" @click="toggleInstalled(skill.name)"><Check v-if="installed.has(skill.name)" :size="15" /><Plus v-else :size="16" /></button></header><p>{{ skill.description }}</p><footer><span v-if="skill.installs">↓ {{ skill.installs >= 1000 ? `${(skill.installs / 1000).toFixed(1).replace('.0', '')}k` : skill.installs }}</span><span v-else>本地技能</span><span v-if="skill.source === 'hub'">SkillHub</span><span><Star :size="11" />{{ skill.source === 'hub' ? '社区' : '内置' }}</span></footer></article></div>
        <div v-else class="skill-empty"><Search :size="22" /><b>{{ hubError ? 'SkillHub 暂无结果' : '没有匹配的技能' }}</b><button @click="query = ''; activeCategory = '全部'; installedOnly = false">清除筛选</button></div>
      </section>
    </main>
    <main v-else class="skill-center__body capability-view"><header><component :is="activeArea === 'experts' ? Bot : Link2" :size="22" /><div><h1>{{ activeArea === 'experts' ? '专家' : '连接器' }}</h1><p>{{ activeArea === 'experts' ? '面向特定开发场景的任务角色' : '连接本地工具与外部服务' }}</p></div></header><div class="capability-grid"><article v-for="item in activeArea === 'experts' ? ['代码审查专家', '前端实现专家', '项目分析专家'] : ['本地工作区', '浏览器连接', 'MCP 服务']" :key="item"><span><Bot v-if="activeArea === 'experts'" :size="19" /><Link2 v-else :size="19" /></span><h2>{{ item }}</h2><p>{{ activeArea === 'experts' ? '用于聚焦任务的可复用角色配置' : '按需授权并管理连接状态' }}</p><button><Plus :size="15" />添加</button></article></div></main>
    <div v-if="addDialogOpen" class="skill-dialog-backdrop" @mousedown.self="addDialogOpen = false"><form class="skill-dialog" role="dialog" aria-modal="true" aria-labelledby="add-skill-title" @submit.prevent="addCustomSkill"><header><div><h2 id="add-skill-title">添加技能</h2><p>从本地目录或 Git 仓库登记技能。</p></div><button type="button" aria-label="关闭" @click="addDialogOpen = false"><X :size="17" /></button></header><label>技能名称<input v-model="customSkillName" autofocus placeholder="例如：release-notes" /></label><label>来源<input v-model="customSkillSource" placeholder="本地路径或仓库地址" /></label><footer><button type="button" @click="addDialogOpen = false">取消</button><button class="primary" :disabled="!customSkillName.trim()">添加</button></footer></form></div>
  </section>
</template>
