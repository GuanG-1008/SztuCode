<script setup lang="ts">
import { Check, ChevronDown, ExternalLink, Eye, EyeOff, Plus, Trash2, X } from "@lucide/vue";
import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { computed, onMounted, ref } from "vue";
import {
  deleteModelProfile, getProviderStatus, listModelProfiles, saveModelProfile,
  type ModelProfile, type ProviderStatus, type RuntimeSettings,
} from "../../services/sztu-runtime";
import { logoForVendor, modelVendors, type ModelVendor } from "./model-vendors";

const emit = defineEmits<{
  close: [];
  updated: [settings: RuntimeSettings, status: ProviderStatus | null];
}>();

const vendors = modelVendors;

const models = ref<ModelProfile[]>([]);
const editorOpen = ref(false);
const selectedVendor = ref<ModelVendor | null>(null);
const name = ref(""); const model = ref(""); const baseUrl = ref(""); const apiKey = ref("");
const provider = ref<"anthropic" | "openai">("anthropic");
const showKey = ref(false); const saving = ref(false); const error = ref("");
const canSave = computed(() => Boolean(selectedVendor.value && name.value.trim() && model.value.trim() && apiKey.value.trim()));

async function refresh() {
  error.value = "";
  try { models.value = await listModelProfiles(); }
  catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
}
function beginAdd() { editorOpen.value = true; selectedVendor.value = null; name.value = ""; model.value = ""; baseUrl.value = ""; apiKey.value = ""; error.value = ""; }
function chooseVendor(item: ModelVendor) { selectedVendor.value = item; name.value = item.name; provider.value = item.provider; baseUrl.value = item.baseUrl; }
async function getApiKey() {
  const url = selectedVendor.value?.apiKeyUrl;
  if (!url) return;
  error.value = "";
  try {
    if (isTauri()) await openUrl(url);
    else window.open(url, "_blank", "noopener,noreferrer");
  } catch (reason) {
    error.value = `无法打开 API 密钥页面：${reason instanceof Error ? reason.message : String(reason)}`;
  }
}
async function save() {
  if (!canSave.value || !selectedVendor.value) return;
  if (baseUrl.value && !/^https?:\/\//i.test(baseUrl.value)) { error.value = "API 地址需要以 http:// 或 https:// 开头"; return; }
  saving.value = true; error.value = "";
  try {
    const result = await saveModelProfile({ name: name.value.trim(), vendor: selectedVendor.value.name, provider: provider.value, model: model.value.trim(), base_url: baseUrl.value.trim(), api_key: apiKey.value.trim() });
    models.value = result.models; emit("updated", result.settings, await getProviderStatus()); editorOpen.value = false;
  } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
  finally { saving.value = false; }
}
async function remove(item: ModelProfile) { if (item.is_current) return; models.value = await deleteModelProfile(item.id); }
onMounted(() => { void refresh(); });
</script>

<template>
  <section class="model-manager" aria-label="模型管理">
    <header><div><h1>模型</h1><p>配置 API Key，添加并管理本机可用模型。</p></div><button type="button" aria-label="关闭模型管理" @click="emit('close')"><X :size="18" /></button></header>
    <div class="model-manager-body">
      <button type="button" class="model-add-button" @click="beginAdd"><Plus :size="15" />添加模型</button>
      <div class="model-table">
        <header><span>模型</span><span>服务商</span><span>接口</span><span>操作</span></header>
        <div v-for="item in models" :key="item.id" class="model-table-row">
          <span><span class="model-table-name"><i class="model-provider-logo"><img v-if="logoForVendor(item.vendor)" :src="logoForVendor(item.vendor)!" alt="" /><span v-else>{{ item.vendor.slice(0, 1).toUpperCase() }}</span></i><span><b>{{ item.name }}</b><small>{{ item.model }}</small></span></span></span><span>{{ item.vendor }}</span><span>{{ item.provider === 'openai' ? 'OpenAI 兼容' : 'Anthropic' }}</span>
          <span><em v-if="item.is_current"><Check :size="12" />当前</em><small v-else-if="item.builtin">内置</small><button v-else type="button" :aria-label="`删除 ${item.name}`" @click="remove(item)"><Trash2 :size="14" /></button></span>
        </div>
        <p v-if="!models.length">暂无自定义模型，点击“添加模型”开始配置。</p>
      </div>
      <p v-if="error && !editorOpen" class="model-manager-error">{{ error }}</p>
    </div>

    <div v-if="editorOpen" class="model-editor-backdrop" @mousedown.self="editorOpen = false">
      <section class="model-editor" role="dialog" aria-modal="true" aria-label="添加模型">
        <header><h2>添加模型</h2><button type="button" aria-label="关闭" @click="editorOpen = false"><X :size="18" /></button></header>
        <div class="model-vendor-grid">
          <button v-for="item in vendors" :key="item.name" type="button" :class="{ active: selectedVendor?.name === item.name }" @click="chooseVendor(item)"><i><img v-if="item.logo" :src="item.logo" alt="" /><span v-else>{{ item.mark }}</span></i><span>{{ item.name }}</span><Check v-if="selectedVendor?.name === item.name" :size="14" /><ChevronDown v-else :size="14" /></button>
        </div>
        <div v-if="selectedVendor" class="model-editor-fields">
          <label><span>配置名称</span><input v-model="name" placeholder="例如 DeepSeek V3" /></label>
          <label><span>接口类型</span><select v-model="provider"><option value="anthropic">Anthropic</option><option value="openai">OpenAI 兼容</option></select></label>
          <label><span>模型 ID</span><input v-model="model" placeholder="例如 deepseek-chat" /></label>
          <label><span>API 地址</span><input v-model="baseUrl" placeholder="留空使用服务商默认地址" /></label>
          <label class="wide"><span class="model-api-key-label"><span>API Key</span><button v-if="selectedVendor.apiKeyUrl" type="button" aria-label="获取 API 密钥" @click="getApiKey">获取 API 密钥<ExternalLink :size="12" /></button></span><div><input v-model="apiKey" :type="showKey ? 'text' : 'password'" placeholder="输入 API Key" /><button type="button" :aria-label="showKey ? '隐藏 API Key' : '显示 API Key'" @click="showKey = !showKey"><EyeOff v-if="showKey" :size="15" /><Eye v-else :size="15" /></button></div></label>
        </div>
        <p v-if="error" class="model-editor-error">{{ error }}</p>
        <footer><button type="button" @click="editorOpen = false">取消</button><button type="button" class="primary" :disabled="!canSave || saving" @click="save">{{ saving ? '保存中' : '提交' }}</button></footer>
      </section>
    </div>
  </section>
</template>
