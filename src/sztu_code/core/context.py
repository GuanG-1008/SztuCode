from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from sztu_code.core.compact.canvas import TaskCanvas


@dataclass
class ExecutionContext:
    run_id: str
    goal: str
    max_steps: int
    prefill_messages: list[dict[str, Any]] = field(default_factory=list)
    session_notes: str = ""
    global_context: str = ""
    project_context: str = ""
    base_system_prompt: str = ""  # 分层基础提示词（runner 构建），空则回退默认
    messages: list[dict[str, Any]] = field(default_factory=list)
    step: int = 0
    status: str = "running"  # "running" | "success" | "failed" | "interrupted"
    reason: str | None = None
    result: str = ""
    # skill 或 subagent 角色可覆盖默认 system prompt
    system_prompt_override: str | None = None
    # 本 run 派生的后台 subagent run_id 集合，结束回合前等待其全部落定
    pending_background_run_ids: set[str] = field(default_factory=set)
    compacted: bool = False
    # Mermaid 任务画布（Phase 2）：由 AgentLoop 维护，注入 system prompt
    canvas: TaskCanvas | None = None
    # ---- agent run 预算 ----
    max_tokens: int = 0           # 累计 input+output tokens 上限；0=不限
    max_wall_clock_s: int = 0     # 累计墙钟秒数上限；0=不限
    total_input_tokens: int = 0   # 已累计 input tokens（每步 LLM 调用后累加）
    total_output_tokens: int = 0  # 已累计 output tokens
    started_at: float = 0.0       # run 开始墙钟（time.monotonic()），loop 惰性初始化

    # 初始化消息历史，优先使用 session 完整回放内容
    def __post_init__(self) -> None:
        if self.prefill_messages:
            self.messages = [dict(m) for m in self.prefill_messages]
        elif not self.messages:
            self.messages.append({"role": "user", "content": self.goal})

    # 返回当前 run 的 system prompt；有 override 时跳过 base，直接注入记忆层
    def system_prompt(self, base: str) -> str:
        parts = [self.system_prompt_override if self.system_prompt_override else base]
        if self.global_context.strip():
            parts.append("\n\n## Global Context\n" + self.global_context.strip())
        if self.project_context.strip():
            parts.append("\n\n## Project Context\n" + self.project_context.strip())
        if self.session_notes.strip():
            parts.append(
                "\n\n## Session Notes\n"
                + self.session_notes.strip()
                + "\n\nRemember important durable facts by calling note_save."
            )
        # Phase 2: 注入 Mermaid 任务画布 — Agent 每一步都能看到当前任务拓扑
        if self.canvas is not None:
            mermaid = self.canvas.render_mermaid()
            summary = self.canvas.recent_summary()
            parts.append("\n\n## Task Canvas\n" + mermaid)
            if summary:
                parts.append("\n最近完成:\n" + summary)
            parts.append(
                "\n画布展示了当前任务的执行进度。节点状态: ✅=完成 🔵=进行中 "
                "⏳=待执行 ❌=失败。使用 read_ref 可查看卸载的完整工具输出。"
            )
        return "".join(parts)

    # 将 LLM 响应的 content blocks 追加为 assistant 消息
    def add_assistant_message(self, content: list[Any]) -> None:
        self.messages.append({"role": "assistant", "content": content})

    # 将工具调用结果追加为 user 消息；同一步的多个结果共享同一条消息
    def add_tool_result(
        self, tool_use_id: str, content: str, is_error: bool = False
    ) -> None:
        block: dict[str, Any] = {
            "type": "tool_result",
            "tool_use_id": tool_use_id,
            "content": content,
        }
        if is_error:
            block["is_error"] = True

        last = self.messages[-1] if self.messages else None
        if (
            last is not None
            and last["role"] == "user"
            and isinstance(last["content"], list)
            and last["content"]
            and all(b.get("type") == "tool_result" for b in last["content"])
        ):
            last["content"].append(block)
        else:
            self.messages.append({"role": "user", "content": [block]})

    # 返回 True 表示 loop 应停止（状态不再是 running）
    def is_done(self) -> bool:
        return self.status != "running"

    # 将 run 标记为成功
    def mark_success(self) -> None:
        self.status = "success"

    # 将 run 标记为失败并记录原因
    def mark_failed(self, reason: str) -> None:
        self.status = "failed"
        self.reason = reason

    # 将 run 标记为中断（预算/上限耗尽但可续跑），区别于真正的失败
    def mark_interrupted(self, reason: str) -> None:
        self.status = "interrupted"
        self.reason = reason

    # 返回累计 token 总数（input + output）
    def total_tokens(self) -> int:
        return self.total_input_tokens + self.total_output_tokens

    # 返回 token 预算是否已耗尽；max_tokens=0 视为不限
    def token_budget_exhausted(self) -> bool:
        return self.max_tokens > 0 and self.total_tokens() >= self.max_tokens

    # 返回 run 已运行的墙钟秒数；started_at 未初始化时返回 0
    def elapsed_s(self) -> float:
        return time.monotonic() - self.started_at if self.started_at > 0 else 0.0

    # 返回墙钟预算是否已超时；max_wall_clock_s=0 视为不限
    def wall_clock_exceeded(self) -> bool:
        return (
            self.max_wall_clock_s > 0
            and self.started_at > 0
            and self.elapsed_s() >= self.max_wall_clock_s
        )
