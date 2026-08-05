<script setup lang="ts">
import { computed, ref } from "vue";
import { ChevronDown, ScrollText } from "@lucide/vue";
const props = defineProps<{ text?: string; completed?: boolean }>();
const open = ref(false);
const label = computed(() => props.completed ? "过程说明" : "当前判断");
</script>

<template>
  <section v-if="text" class="thinking-panel" :class="{ open }">
    <button @click="open = !open"><ScrollText :size="15" /><span>{{ label }}</span><ChevronDown :size="14" /></button>
    <pre v-if="open">{{ text }}</pre>
  </section>
</template>
