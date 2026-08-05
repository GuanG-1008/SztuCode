<script setup lang="ts">
import { computed, ref } from "vue";
import {
  Bot, Boxes, Check, ChevronDown, CirclePlus, Code2, Database, FileText,
  Image, Link2, PackageCheck, Plus, RefreshCw, Search, Sparkles, Star,
  WandSparkles, X,
} from "@lucide/vue";
import { BUILT_IN_SKILLS } from "../CommandPalette/slash-menu";

type Skill = { name: string; description: string };
type SkillItem = Skill & { category: string; installs: string; rating: number; tone: string };

const props = defineProps<{ skills: Skill[]; connected: boolean }>();

const activeArea = ref<"experts" | "skills" | "connectors">("skills");
const activeCollection = ref<"recommended" | "hub" | "bundles">("hub");
const activeCategory = ref("全部");
const query = ref("");
const installedOnly = ref(false);
const featuredOffset = ref(0);
const addDialogOpen = ref(false);
const customSkillName = ref("");
const customSkillSource = ref("");
const installed = ref(new Set(["frontend-design", "find-skills", "review-agent", "documents", "imagegen", "visualize", "openai-docs"]));

const metadata: Record<string, Pick<SkillItem, "category" | "installs" | "rating" | "tone">> = {
  "frontend-design": { category: "设计多媒体", installs: "28k", rating: 312, tone: "graphite" },
  "find-skills": { category: "AI Agent", installs: "22k", rating: 268, tone: "lime" },
  "review-agent": { category: "开发编程", installs: "19k", rating: 241, tone: "coral" },
  documents: { category: "办公效率", installs: "17k", rating: 186, tone: "blue" },
  presentations: { category: "办公效率", installs: "15k", rating: 173, tone: "amber" },
  spreadsheets: { category: "数据分析", installs: "14k", rating: 164, tone: "green" },
  pdf: { category: "内容创作", installs: "13k", rating: 149, tone: "olive" },
  imagegen: { category: "设计多媒体", installs: "12k", rating: 138, tone: "rose" },
  visualize: { category: "数据分析", installs: "11k", rating: 126, tone: "cyan" },
  "openai-docs": { category: "知识管理", installs: "9k", rating: 104, tone: "black" },
  "skill-creator": { category: "开发编程", installs: "8k", rating: 93, tone: "violet" },
  "plugin-creator": { category: "开发编程", installs: "7k", rating: 81, tone: "orange" },
};

const allSkills = computed<SkillItem[]>(() => {
  const merged = new Map(BUILT_IN_SKILLS.map((skill) => [skill.name.toLowerCase(), skill]));
  for (const skill of props.skills) merged.set(skill.name.toLowerCase(), skill);
  return [...merged.values()].map((skill, index) => ({
    ...skill,
    ...(metadata[skill.name] ?? {
      category: "AI Agent",
      installs: `${Math.max(1, 6 - Math.floor(index / 3))}k`,
      rating: Math.max(18, 76 - index * 3),
      tone: ["graphite", "green", "amber", "blue"][index % 4],
    }),
  }));
});

const featured = computed(() => Array.from({ length: Math.min(3, allSkills.value.length) }, (_, index) => allSkills.value[(featuredOffset.value + index) % allSkills.value.length]));
const filteredSkills = computed(() => {
  const value = query.value.trim().toLowerCase();
  return allSkills.value.filter((skill) =>
    (activeCategory.value === "全部" || skill.category === activeCategory.value) &&
    (!installedOnly.value || installed.value.has(skill.name)) &&
    (!value || `${skill.name} ${skill.description} ${skill.category}`.toLowerCase().includes(value)),
  );
});
const categories = ["全部", "办公效率", "内容创作", "开发编程", "数据分析", "设计多媒体", "AI Agent", "知识管理"];

function toggleInstalled(name: string) {
  const next = new Set(installed.value);
  next.has(name) ? next.delete(name) : next.add(name);
  installed.value = next;
}
function rotateFeatured() { featuredOffset.value = (featuredOffset.value + 3) % Math.max(1, allSkills.value.length); }
function addCustomSkill() {
  const name = customSkillName.value.trim();
  if (!name) return;
  installed.value = new Set([...installed.value, name]);
  customSkillName.value = "";
  customSkillSource.value = "";
  addDialogOpen.value = false;
}
function iconFor(skill: SkillItem) {
  if (skill.category === "开发编程") return Code2;
  if (skill.category === "数据分析") return Database;
  if (skill.category === "设计多媒体") return Image;
  if (skill.category === "办公效率" || skill.category === "内容创作") return FileText;
  return Sparkles;
}
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
        <button :class="{ active: installedOnly }" @click="installedOnly = !installedOnly"><PackageCheck :size="16" />我安装的 <span>{{ installed.size }}</span></button>
        <button @click="addDialogOpen = true"><CirclePlus :size="16" />添加技能</button>
      </div>
    </header>

    <main v-if="activeArea === 'skills'" class="skill-center__body">
      <section class="featured-skills" aria-labelledby="featured-title">
        <header><h1 id="featured-title">精选技能</h1><button @click="rotateFeatured"><RefreshCw :size="14" />换一换</button></header>
        <div>
          <article v-for="skill in featured" :key="skill.name" class="featured-skill">
            <component :is="iconFor(skill)" :size="21" class="skill-logo" :data-tone="skill.tone" />
            <div><h2>{{ skill.name }}</h2><p>{{ skill.description }}</p></div>
            <button :aria-label="`${installed.has(skill.name) ? '移除' : '添加'} ${skill.name}`" :class="{ installed: installed.has(skill.name) }" @click="toggleInstalled(skill.name)"><Check v-if="installed.has(skill.name)" :size="15" /><Plus v-else :size="16" /></button>
          </article>
        </div>
      </section>

      <section class="skill-catalog" aria-labelledby="catalog-title">
        <header class="skill-catalog__tabs">
          <button :class="{ active: activeCollection === 'recommended' }" @click="activeCollection = 'recommended'">推荐</button>
          <button id="catalog-title" :class="{ active: activeCollection === 'hub' }" @click="activeCollection = 'hub'">SkillHub</button>
          <button :class="{ active: activeCollection === 'bundles' }" @click="activeCollection = 'bundles'">套件</button>
          <small v-if="!connected">内建目录</small>
        </header>
        <div class="skill-catalog__filters">
          <button v-for="category in categories" :key="category" :class="{ active: activeCategory === category }" @click="activeCategory = category">{{ category }}</button>
          <button class="skill-sort">综合评分<ChevronDown :size="13" /></button>
        </div>
        <div v-if="filteredSkills.length" class="skill-grid">
          <article v-for="skill in filteredSkills" :key="skill.name" class="skill-card">
            <header>
              <component :is="iconFor(skill)" :size="19" class="skill-logo" :data-tone="skill.tone" />
              <h2>{{ skill.name }}</h2>
              <button :aria-label="`${installed.has(skill.name) ? '移除' : '添加'} ${skill.name}`" :class="{ installed: installed.has(skill.name) }" @click="toggleInstalled(skill.name)"><Check v-if="installed.has(skill.name)" :size="15" /><Plus v-else :size="16" /></button>
            </header>
            <p>{{ skill.description }}</p>
            <footer><span>↓ {{ skill.installs }}</span><span><Star :size="11" />{{ skill.rating }}</span></footer>
          </article>
        </div>
        <div v-else class="skill-empty"><Search :size="22" /><b>没有匹配的技能</b><button @click="query = ''; activeCategory = '全部'; installedOnly = false">清除筛选</button></div>
      </section>
    </main>

    <main v-else class="skill-center__body capability-view">
      <header><component :is="activeArea === 'experts' ? Bot : Boxes" :size="22" /><div><h1>{{ activeArea === 'experts' ? '专家' : '连接器' }}</h1><p>{{ activeArea === 'experts' ? '面向特定开发场景的任务角色' : '连接本地工具与外部服务' }}</p></div></header>
      <div class="capability-grid">
        <article v-for="item in activeArea === 'experts' ? ['代码审查专家','前端实现专家','项目分析专家'] : ['本地工作区','浏览器连接','MCP 服务']" :key="item"><span><Bot v-if="activeArea === 'experts'" :size="19" /><Link2 v-else :size="19" /></span><h2>{{ item }}</h2><p>{{ activeArea === 'experts' ? '用于聚焦任务的可复用角色配置' : '按需授权并管理连接状态' }}</p><button><Plus :size="15" />添加</button></article>
      </div>
    </main>

    <div v-if="addDialogOpen" class="skill-dialog-backdrop" @mousedown.self="addDialogOpen = false">
      <form class="skill-dialog" role="dialog" aria-modal="true" aria-labelledby="add-skill-title" @submit.prevent="addCustomSkill">
        <header><div><h2 id="add-skill-title">添加技能</h2><p>从本地目录或 Git 仓库登记技能。</p></div><button type="button" aria-label="关闭" @click="addDialogOpen = false"><X :size="17" /></button></header>
        <label>技能名称<input v-model="customSkillName" autofocus placeholder="例如：release-notes" /></label>
        <label>来源<input v-model="customSkillSource" placeholder="本地路径或仓库地址" /></label>
        <footer><button type="button" @click="addDialogOpen = false">取消</button><button class="primary" :disabled="!customSkillName.trim()">添加</button></footer>
      </form>
    </div>
  </section>
</template>
