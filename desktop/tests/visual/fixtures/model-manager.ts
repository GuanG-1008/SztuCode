import { createApp } from "vue";
import ModelManager from "../../../src/components/ModelConfig/ModelManager.vue";
import "../../../src/workbench.css";

// ModelManager 组件独立挂载 fixture：测试通过 page.goto 访问本页面，
// 再通过 Vue 组件实例注入状态/触发交互（与 diff-review fixture 同一模式）。
// IPC 在浏览器中无 daemon，需先 mock，保证模型列表可正常渲染。
// 外层包 .model-manager-backdrop 以模拟 App.vue 中的真实挂载结构
// （编辑器 backdrop 为 position:absolute，需要 fixed 祖先定位）。
type RequestFn = (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;
const originalRequest = (window as unknown as { __ipcOriginalRequest?: RequestFn }).__ipcOriginalRequest;

import("../../../src/lib/ipc").then(({ IpcClient }) => {
  IpcClient.prototype.request = async (method: string) => {
    if (method === "provider.model_list") {
      return {
        models: [
          { id: "m1", name: "DeepSeek V3 (长配置名称用于验证窄窗口省略与 title 提示)", vendor: "DeepSeek", provider: "openai", model: "deepseek-chat-20260701", builtin: false, is_current: true, base_url: "https://api.deepseek.com/v1" },
          { id: "m2", name: "火山引擎 Doubao", vendor: "火山引擎", provider: "openai", model: "doubao-seed-1.6-flash", builtin: false, is_current: false, base_url: "" },
          { id: "m3", name: "Anthropic Claude", vendor: "AWS", provider: "anthropic", model: "claude-sonnet-4-5", builtin: true, is_current: false, base_url: "" },
          { id: "m4", name: "MiniMax Global (超长模型 ID 验证省略行为)", vendor: "MiniMax Global", provider: "anthropic", model: "MiniMax-Text-01-2026-08-long-model-id", builtin: false, is_current: false, base_url: "" },
        ],
      };
    }
    return {};
  };
  void originalRequest;
  createApp(ModelManager).mount("#app");
});
