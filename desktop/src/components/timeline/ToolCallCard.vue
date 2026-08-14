<script setup lang="ts">
import { computed, ref } from "vue";
import { ChevronDown, CircleAlert, FilePenLine, FileText, LoaderCircle, Search, Terminal } from "@lucide/vue";
import type { ToolCallEntry } from "./types";

const props = defineProps<{ call: ToolCallEntry }>();
const open = ref(false);
const request = computed(() => JSON.stringify(props.call.params, null, 2));
const detail = computed(() => {
  const value = props.call.params.command ?? props.call.params.cmd ?? props.call.params.path ?? props.call.params.query ?? props.call.params.description;
  return typeof value === "string" ? value : props.call.name;
});
const kind = computed(() => {
  const name = props.call.name.toLowerCase();
  if (/edit|write/.test(name)) return "edit";
  if (/grep|glob|search/.test(name)) return "search";
  if (/read|file|dir/.test(name)) return "file";
  return "command";
});
const title = computed(() => {
  if (props.call.status === "failed") return `运行失败 ${detail.value}`;
  const prefix = props.call.status === "running" ? "正在" : props.call.status === "failed" ? "运行失败" : "已运行";
  if (kind.value === "edit") return `${props.call.status === "running" ? "正在编辑" : "已编辑"} ${detail.value}`;
  if (kind.value === "search") return `${props.call.status === "running" ? "正在搜索" : "已搜索"} ${detail.value}`;
  if (kind.value === "file") return `${props.call.status === "running" ? "正在读取" : "已读取"} ${detail.value}`;
  return `${prefix} ${detail.value}`;
});
const isFileTool = computed(() => /read|file|dir|search/i.test(props.call.name));
</script>

<template>
  <section class="tool-call-event" :class="call.status">
    <button @click="open = !open">
      <FilePenLine v-if="kind === 'edit'" :size="16" />
      <Search v-else-if="kind === 'search'" :size="16" />
      <FileText v-else-if="isFileTool" :size="16" />
      <Terminal v-else :size="16" />
      <span>{{ title }}</span>
      <LoaderCircle v-if="call.status === 'running'" class="spin" :size="14" />
      <CircleAlert v-else-if="call.status === 'failed'" :size="14" />
      <ChevronDown :size="14" />
    </button>
    <div v-if="open" class="tool-call-event__details">
      <b>输入</b><pre>{{ request }}</pre>
      <template v-if="call.output || call.error"><b>{{ call.error ? '错误' : '输出' }}</b><pre>{{ call.error || call.output }}</pre></template>
    </div>
  </section>
</template>
