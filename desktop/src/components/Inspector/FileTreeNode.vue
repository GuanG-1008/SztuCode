<script setup lang="ts">
import { ChevronRight, FileText, Folder, FolderOpen, LoaderCircle } from "@lucide/vue";
import type { TreeNode } from "./FileTree.vue";

// 递归组件：显式命名保证模板内自引用 `<FileTreeNode>` 可靠解析
defineOptions({ name: "FileTreeNode" });

const props = defineProps<{
  node: TreeNode;
  depth: number;
  selectedPath: string;
}>();
const emit = defineEmits<{ toggle: [node: TreeNode]; open: [node: TreeNode] }>();

// 点击目录行：折叠/展开由父组件懒加载 children；点击文件行：请求预览内容
function onRowClick() {
  if (props.node.kind === "directory") emit("toggle", props.node);
  else emit("open", props.node);
}
</script>

<template>
  <div class="file-tree-node">
    <div
      class="file-row"
      :class="{
        dir: node.kind === 'directory',
        active: selectedPath === node.path,
        [`depth-${Math.min(depth, 6)}`]: true,
      }"
      role="treeitem"
      :aria-expanded="node.kind === 'directory' ? Boolean(node.children) : undefined"
      @click="onRowClick"
    >
      <ChevronRight v-if="node.kind === 'directory'" :size="13" class="row-chevron" :class="{ expanded: node.children }" />
      <span class="row-icon">
        <FolderOpen v-if="node.kind === 'directory' && node.children" :size="15" />
        <Folder v-else-if="node.kind === 'directory'" :size="15" />
        <FileText v-else :size="15" />
      </span>
      <span class="row-name">{{ node.name }}</span>
      <LoaderCircle v-if="node.loading" :size="12" class="spin" />
    </div>
    <ul v-if="node.children" class="file-tree file-tree--nested" role="group">
      <li v-for="child in node.children" :key="child.path">
        <FileTreeNode :node="child" :depth="depth + 1" :selected-path="selectedPath" @toggle="emit('toggle', $event)" @open="emit('open', $event)" />
      </li>
    </ul>
  </div>
</template>
