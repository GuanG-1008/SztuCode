# 测试指南

[返回文档中心](../README.md)

SztuCode 的测试范围应与变更风险匹配。不要把“全量测试通过”作为替代针对性测试的理由，也不要为纯文档改动运行会触发外部模型或写入大量状态的测试。

## 单元测试

```bash
uv run pytest tests/unit -v
```

适用于协议模型、配置、工具、权限、上下文、会话存储和纯 UI 状态逻辑。单个测试：

```bash
uv run pytest tests/unit/test_envelope.py::test_request_roundtrip -v
```

新增测试应覆盖正常路径、输入边界和关键失败路径。涉及权限时至少覆盖允许和拒绝。

## 集成测试

```bash
uv run pytest tests/integration -v
```

集成 fixture 会选择随机本地端口、启动真实 daemon 子进程并等待 TCP 就绪；运行前不应已有依赖固定端口的测试 daemon。集成测试适合验证：

- JSON-RPC 请求响应；
- 会话创建、消息和事件流；
- 权限审批闭环；
- daemon 启停与断线行为；
- 多模块协作产生的状态。

带 `integration` marker 的用例可能调用真实模型 API，需要对应凭据。提交 PR 时应在验证说明中区分本地 daemon 集成测试和真实 Provider 测试。

## 全量 Python 测试

```bash
uv run pytest tests/ -v
```

跨模块契约、共享基础设施或发布前变更应运行全量测试。

## 静态检查

```bash
uv run ruff check src tests scripts
uv run mypy src
```

Ruff 检查代码规范和导入；mypy 使用 strict 模式检查 `src/`。不要用全局 ignore 绕过单个真实类型问题。

## 协议一致性

```bash
uv run python scripts/gen_protocol_doc.py
uv run python scripts/gen_protocol_doc.py --check
```

第一条重新生成 `docs/reference/wire-protocol.md`，第二条验证生成结果与模型一致。协议变更必须提交生成文件。

## 桌面端

```bash
cd desktop
npm run build

cd src-tauri
cargo check
```

视觉测试入口为：

```bash
cd desktop
npx playwright install chromium
npm run test:visual
```

默认使用 Playwright 安装的 Chromium，不向 `launchOptions` 写入硬编码本机路径。如需覆盖，可设置环境变量 `PLAYWRIGHT_CHROMIUM_PATH` 指向浏览器可执行文件。不要把个人绝对路径提交进仓库。

轻量配置单元测试：

```bash
cd desktop
npm run test:unit
```

UI 变更应验证至少一个常规桌面宽度和一个窄窗口，重点检查文本溢出、权限卡、时间线、Diff 页面和空/错误状态。macOS 上还应确认系统 traffic lights 与导航按钮不重叠。
## 评估

Agent 任务质量评估与普通回归测试用途不同。SWE-bench、轨迹分析和评测报告的运行方式见 [评估指南](../guides/evaluation.md)。评估产物可能体积较大或包含外部仓库内容，不应默认提交。

## PR 中报告验证结果

建议写明实际执行结果，而不是只写“tests passed”：

```text
Validation
- uv run ruff check src tests scripts
- uv run mypy src
- uv run pytest tests/unit/test_permission_manager.py -v
- npm run build (desktop)

Not run
- full integration suite: change does not touch daemon behavior
```
