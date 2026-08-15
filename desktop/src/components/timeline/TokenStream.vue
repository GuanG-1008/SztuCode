<script setup lang="ts">
import { computed, ref, watch } from "vue";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { useThrottledVisualUpdate } from "../../composables/useThrottledVisualUpdate";

const props = defineProps<{ tokens: string[]; finalText?: string }>();
const text = computed(() => props.finalText || props.tokens.join(""));
// 流式 Markdown 重解析按 3 帧节流（借鉴 dsh 流式正文管线）：
// 一帧内 N 次文本更新合并为一次 marked 解析 + DOMPurify 清洗，
// 渲染滞后 ≤3 帧（约 50ms）不可感知，长文本流式时解析频率降为 1/3
const rendered = ref(text.value);
const scheduleRender = useThrottledVisualUpdate(() => { rendered.value = text.value; });
watch(text, () => scheduleRender());
const html = computed(() => DOMPurify.sanitize(marked.parse(rendered.value, { async: false }) as string));
</script>

<template>
  <div v-if="text" class="token-stream markdown-body" :class="{ streaming: !finalText }">
    <div v-html="html" />
    <i v-if="!finalText" />
  </div>
</template>
