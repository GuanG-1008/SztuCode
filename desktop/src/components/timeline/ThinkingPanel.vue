<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { BrainCircuit, ChevronDown } from "@lucide/vue";
import { reasoningSummary } from "../../utils/reasoningSummary";

const props = defineProps<{ text?: string; completed?: boolean }>();
const open = ref(false);
const running = computed(() => !props.completed);
const label = computed(() => props.completed ? "过程说明" : "当前判断");

// 折叠摘要（借鉴 dsh ReasoningRow）：流式中显示最后一行非空文本跟随输出，
// 结算后显示首行作为稳定标题 —— 折叠态渲染代价恒定，与文本总长度无关
const summary = computed(() => reasoningSummary(props.text ?? "", running.value));

// 每次增量渲染后立即跟到摘要末尾；结算后回到行首。
// flush: post 保证测量的是本次文字更新后的 DOM。
const summaryRef = ref<HTMLElement | null>(null);
watch([summary, running], () => {
  const element = summaryRef.value;
  if (element === null) return;
  element.scrollLeft = running.value ? element.scrollWidth - element.clientWidth : 0;
}, { flush: "post" });
</script>

<template>
  <section v-if="text" class="thinking-panel" :data-state="running ? 'running' : 'ok'" :class="{ open }">
    <button type="button" :aria-label="label" :aria-expanded="open" @click="open = !open">
      <BrainCircuit class="thinking-panel__icon" :size="14" />
      <span class="thinking-panel__label">Think</span>
      <span class="timeline-row__separator">·</span>
      <span ref="summaryRef" class="thinking-panel__preview" :data-follow-end="running || undefined">{{ summary }}</span>
      <ChevronDown class="timeline-row__chevron" :size="13" />
    </button>
    <pre v-if="open" class="thinking-panel__details">{{ text }}</pre>
  </section>
</template>
