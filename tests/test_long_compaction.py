"""合成长对话 — 验证滑动窗口压缩在实际长对话中的效果"""
from __future__ import annotations

import asyncio
import uuid
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from sztu_code.core.compact.compactor import (
    CompactionResult,
    Compactor,
    _flatten_turns,
    _split_into_turns,
)
from sztu_code.core.events.bus import EventBus
from sztu_code.core.llm.types import LlmResponse, UsageStats


# 构造模拟 LLM 响应的 provider
def _stub_provider(summary: str | None = None) -> Any:
    provider = MagicMock()
    if summary is None:
        summary = (
            "## 1. Original Goal\n"
            "Fix the bug in the authentication module.\n\n"
            "## 2. Completed Steps\n"
            "- Read auth.py and identified the issue\n"
            "- Fixed token validation logic\n"
            "- Wrote unit tests\n\n"
            "## 3. Key Constraints & Discoveries\n"
            "- JWT tokens use RS256 algorithm\n"
            "- Token expiry is 3600 seconds\n\n"
            "## 4. Current File State\n"
            "- src/auth.py: fixed token validation\n"
            "- tests/test_auth.py: added 5 test cases\n\n"
            "## 5. Remaining TODOs\n"
            "1. Update documentation\n"
            "2. Run integration tests\n\n"
            "## 6. Critical Data\n"
            "- JWT_SECRET from env var\n"
            "- User ID format: uuid4\n"
        )
    provider.chat = AsyncMock(return_value=LlmResponse(
        stop_reason="end_turn",
        text=summary,
        usage=UsageStats(input_tokens=5000, output_tokens=300),
    ))
    return provider


# 构造一个长对话（N 个 turn，每个 turn = assistant + user(tool_results)）
def _build_long_conversation(num_turns: int, base_size: int = 800) -> list[dict[str, Any]]:
    """构造 num_turns 个完整 turn，每 turn 约 base_size 字符"""
    messages: list[dict[str, Any]] = [
        {
            "role": "user",
            "content": (
                "Please fix the authentication bug in the codebase. "
                "The issue is that tokens are not being validated correctly. "
                "Search the codebase, identify the root cause, fix it, and verify with tests."
            ),
        }
    ]

    for t in range(num_turns):
        # assistant 消息：模拟工具调用 + 思考
        assistant_content: list[dict[str, Any]] = []
        # 思考块
        thinking_text = (
            f"Let me analyze step {t}. I need to understand the code structure. "
            + "x" * (base_size // 2)
        )
        assistant_content.append({
            "type": "thinking",
            "thinking": thinking_text,
        })
        if t < num_turns - 1:
            # 工具调用
            assistant_content.append({
                "type": "text",
                "text": f"I'll now read the relevant files for step {t}.",
            })
            tool_id = f"toolu_{uuid.uuid4().hex[:8]}"
            assistant_content.append({
                "type": "tool_use",
                "id": tool_id,
                "name": "read",
                "input": {"file_path": f"src/module_{t}.py"},
            })
            messages.append({"role": "assistant", "content": assistant_content})
            # user 消息：工具结果
            result_text = f"File contents for module_{t}.py:\n" + "y" * base_size
            messages.append({
                "role": "user",
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": tool_id,
                        "content": result_text,
                    }
                ],
            })
        else:
            # 最后一轮：end_turn
            assistant_content.append({
                "type": "text",
                "text": "The authentication bug has been fixed. Tests pass.",
            })
            messages.append({"role": "assistant", "content": assistant_content})

    return messages


class TestLongConversationTurnDetection:
    """验证 turn 检测在长对话中的正确性"""

    def test_split_50_turns(self) -> None:
        """50 轮对话应正确切分为 1 序言 + 50 body turn"""
        msgs = _build_long_conversation(50)
        turns = _split_into_turns(msgs)

        assert len(turns) == 51  # 1 preamble + 50 body
        # 序言应该是 goal text
        assert isinstance(turns[0][0]["content"], str)
        assert "authentication bug" in turns[0][0]["content"]

        # 每个 body turn 应该包含至少 1 条 assistant（最后一个 turn 可能是纯 assistant end_turn）
        for turn in turns[1:]:
            roles = [m["role"] for m in turn]
            assert "assistant" in roles

    def test_flatten_roundtrip(self) -> None:
        """切分后展平应该恢复原始消息列表"""
        msgs = _build_long_conversation(20)
        turns = _split_into_turns(msgs)
        restored = _flatten_turns(turns)
        assert restored == msgs

    def test_sliding_window_preserves_recent_turns(self) -> None:
        """滑动窗口压缩只压缩旧 turn，保留最近 N 个 turn"""
        msgs = _build_long_conversation(30)
        turns = _split_into_turns(msgs)
        body_turns = turns[1:]

        sliding_window_size = 3
        old_turns = body_turns[:-sliding_window_size]
        recent_turns = body_turns[-sliding_window_size:]

        # 旧 turn 应该是 27 个（30 - 3）
        assert len(old_turns) == 27
        # 最近 turn 应该是 3 个
        assert len(recent_turns) == 3

        # 最近 turn 的内容应该包含最后几个 step 的文本
        flat_recent = _flatten_turns(recent_turns)
        recent_text = str(flat_recent)
        assert "module_29" in recent_text or "29" in recent_text
        assert "module_28" in recent_text or "28" in recent_text

    def test_turn_count_growth_linear(self) -> None:
        """验证 turn 数随对话增长线性增加（触发滑动窗口压缩的前提）"""
        for n in [10, 20, 30, 50]:
            msgs = _build_long_conversation(n)
            turns = _split_into_turns(msgs)
            assert len(turns) == n + 1  # preamble + n body turns


class TestSlidingWindowCompactionLong:
    """端到端验证滑动窗口压缩在长对话中的行为"""

    async def test_compact_50_turns_sliding_window_3(self) -> None:
        """50 轮对话 + 滑动窗口=3：旧 47 轮被摘要，最近 3 轮保留"""
        bus = EventBus()
        session_dir = Path("eval/reports")
        compactor = Compactor(bus, session_dir, "test-session-long")
        provider = _stub_provider()
        msgs = _build_long_conversation(50)

        result, new_msgs = await compactor.compact_messages(
            msgs, provider, sliding_window_size=3,
        )

        # 结果不应为 None
        assert result is not None
        assert new_msgs is not None

        # 新消息列表应该包含：序言 + summary pair + 最近 3 turn
        assert len(new_msgs) < len(msgs), (
            f"压缩后消息应减少: {len(new_msgs)} vs {len(msgs)}"
        )

        # 序言应保留
        assert isinstance(new_msgs[0]["content"], str)
        assert "authentication bug" in new_msgs[0]["content"]

        # 应该有摘要续接消息
        assert new_msgs[1]["role"] == "user"
        assert "This session is being continued" in new_msgs[1]["content"]
        assert new_msgs[2]["role"] == "assistant"
        assert "Understood" in str(new_msgs[2]["content"])

        # 最近 3 turn 应该完整保留
        assert "module_49" in str(new_msgs) or "module_47" in str(new_msgs)

        # 旧 turn（前 47 轮）不应出现在新消息中
        assert "module_0.py" not in str(new_msgs)
        assert "module_5.py" not in str(new_msgs)

        # 摘要应该包含有意义的内容
        assert len(result.summary_text) > 100
        assert "Original Goal" in result.summary_text

    async def test_compact_100_turns_sliding_window_5(self) -> None:
        """100 轮对话 + 滑动窗口=5：旧 95 轮被摘要，最近 5 轮保留"""
        bus = EventBus()
        session_dir = Path("eval/reports")
        compactor = Compactor(bus, session_dir, "test-session-100")
        provider = _stub_provider()
        msgs = _build_long_conversation(100, base_size=300)

        result, new_msgs = await compactor.compact_messages(
            msgs, provider, sliding_window_size=5,
        )

        assert result is not None
        assert new_msgs is not None

        # 消息数量应大幅减少（100 turn × 2 msg + 1 preamble = 201 msg）
        assert len(new_msgs) < len(msgs), (
            f"压缩后消息应减少: {len(new_msgs)} vs {len(msgs)}"
        )

        # 旧轮次不应该出现
        assert "module_0.py" not in str(new_msgs)
        assert "module_50.py" not in str(new_msgs)

        # 最近轮次应保留
        recent_text = str(new_msgs)
        found_recent = any(
            f"module_{n}" in recent_text for n in range(95, 100)
        )
        assert found_recent, "最近 5 轮应保留"

        # 摘要应有意义
        assert len(result.summary_text) > 100

    async def test_token_savings_long_conversation(self) -> None:
        """验证长对话压缩的 token 节省效果"""
        from sztu_code.core.compact.token_counter import TokenCounter

        bus = EventBus()
        session_dir = Path("eval/reports")
        compactor = Compactor(bus, session_dir, "test-token-save")
        provider = _stub_provider()
        msgs = _build_long_conversation(60, base_size=400)

        counter = TokenCounter()
        original_tokens = counter.count(
            "\n\n".join(str(m) for m in msgs)
        )

        result, new_msgs = await compactor.compact_messages(
            msgs, provider, sliding_window_size=3,
        )

        assert result is not None
        assert new_msgs is not None

        compacted_tokens = counter.count(
            "\n\n".join(str(m) for m in new_msgs)
        )

        # 压缩后 token 应显著减少
        savings_pct = (1 - compacted_tokens / original_tokens) * 100
        assert savings_pct > 30, (
            f"Token 节省应 >30%, 实际 {savings_pct:.1f}% "
            f"(original={original_tokens}, compacted={compacted_tokens})"
        )

        # 摘要 token 不应超过原始 token
        assert result.summary_tokens < result.original_token_estimate

    async def test_second_compaction_smaller_input(self) -> None:
        """第二次压缩（已压缩 + 新增 turn）：输入更小，更快完成"""
        bus = EventBus()
        session_dir = Path("eval/reports")
        compactor = Compactor(bus, session_dir, "test-second")
        provider = _stub_provider()

        # 第一次压缩：50 轮
        msgs = _build_long_conversation(50, base_size=400)
        result1, compacted1 = await compactor.compact_messages(
            msgs, provider, sliding_window_size=3, compaction_count=0,
        )
        assert result1 is not None and compacted1 is not None

        # 模拟继续对话：在压缩结果上追加 10 个新 turn
        new_turns_messages = _build_long_conversation(10, base_size=400)
        new_body_only = _split_into_turns(new_turns_messages)[1:]  # 去掉序言
        extended = compacted1 + _flatten_turns(new_body_only)

        # 第二次压缩
        provider2 = _stub_provider()
        result2, compacted2 = await compactor.compact_messages(
            extended, provider2, sliding_window_size=3, compaction_count=1,
        )
        assert result2 is not None and compacted2 is not None

        # 第二次压缩的原始 token 估算应该更小（旧 turn 已经被摘要了）
        assert result2.original_token_estimate < result1.original_token_estimate, (
            f"第二次压缩输入应更小: {result2.original_token_estimate} vs {result1.original_token_estimate}"
        )

    async def test_old_turns_too_small_no_failure(self) -> None:
        """旧 turn 太小（< 2000 tokens）→ 跳过，不计入失败"""
        bus = EventBus()
        session_dir = Path("eval/reports")
        compactor = Compactor(bus, session_dir, "test-small")

        # 构造一个只有少量短 turn 的对话
        msgs = _build_long_conversation(8, base_size=50)  # 很小的 turn
        provider = _stub_provider()

        result, new_msgs = await compactor.compact_messages(
            msgs, provider, sliding_window_size=3,
        )
        # result 非 None 但 new_msgs 为 None → 跳过
        assert result is not None
        assert new_msgs is None
        # 不应调用 LLM（太小跳过）
        provider.chat.assert_not_called()


# 运行所有测试
if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])
