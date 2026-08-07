from __future__ import annotations

import sys
from pathlib import Path

# eval 不在安装包内（pyproject 仅打包 src/sztu_code），将仓库根目录加入导入路径
_SRC_ROOT = Path(__file__).resolve().parents[2]
if str(_SRC_ROOT) not in sys.path:
    sys.path.insert(0, str(_SRC_ROOT))

from eval.swebench.adapter import TokenUsage, summarize_token_usage  # noqa: E402

from sztu_code.core.bus.events import LlmUsageEvent  # noqa: E402


# 功能：多个 llm.usage 事件按顶层字段正确累计输入、输出与缓存 token
# 设计：构造两个与 LlmUsageEvent 形状一致的事件，断言四类 token 分别相加，覆盖 issue 根因场景
def test_sums_top_level_usage_across_multiple_events() -> None:
    events = [
        {
            "type": "llm.usage", "run_id": "r1", "ts": "t1",
            "input_tokens": 100, "output_tokens": 10,
            "cache_read_input_tokens": 50, "cache_creation_input_tokens": 5,
        },
        {
            "type": "llm.usage", "run_id": "r2", "ts": "t2",
            "input_tokens": 200, "output_tokens": 20,
            "cache_read_input_tokens": 60, "cache_creation_input_tokens": 6,
        },
    ]
    usage = summarize_token_usage(events)
    assert usage.input_tokens == 300
    assert usage.output_tokens == 30
    assert usage.cache_read_input_tokens == 110
    assert usage.cache_creation_input_tokens == 11


# 功能：缺失字段按 0 处理，不抛出异常
# 设计：事件只带部分字段，断言其余字段为 0，验证 get 默认值兜底路径
def test_missing_fields_default_to_zero() -> None:
    events = [{"type": "llm.usage", "run_id": "r1", "input_tokens": 7}]
    usage = summarize_token_usage(events)
    assert usage.input_tokens == 7
    assert usage.output_tokens == 0
    assert usage.cache_read_input_tokens == 0
    assert usage.cache_creation_input_tokens == 0


# 功能：字段显式为 None 时按 0 处理，不抛出异常
# 设计：事件序列化可能带 None 空值，or 0 兜底保证加法恒为 int
def test_none_fields_default_to_zero() -> None:
    events = [
        {
            "type": "llm.usage", "run_id": "r1", "ts": "t1",
            "input_tokens": None, "output_tokens": None,
            "cache_read_input_tokens": None, "cache_creation_input_tokens": None,
        },
    ]
    usage = summarize_token_usage(events)
    assert usage.input_tokens == 0
    assert usage.output_tokens == 0
    assert usage.cache_read_input_tokens == 0
    assert usage.cache_creation_input_tokens == 0


# 功能：非 llm.usage 事件（即使带相似字段名）不影响统计
# 设计：混入 run.finished / tool.* 事件并携带 input_tokens 字段，断言全零，防止类型误判
def test_ignores_non_usage_events() -> None:
    events = [
        {"type": "run.finished", "run_id": "r1", "status": "success", "input_tokens": 999},
        {"type": "tool.call_started", "tool_name": "bash", "input_tokens": 1},
        {"type": "step.started", "step": 1},
    ]
    usage = summarize_token_usage(events)
    assert usage == TokenUsage()


# 功能：空事件列表返回全零汇总
# 设计：无事件是最简输入，断言 dataclass 相等即可覆盖默认值
def test_empty_events_yield_zero_usage() -> None:
    assert summarize_token_usage([]) == TokenUsage()


# 功能：直接消费 LlmUsageEvent 模型序列化产物，与现行协议字段保持一致
# 设计：用真实 pydantic 模型 model_dump 喂给函数，字段改名或形状变化时此测试会失败，
#      防止模型升级后统计静默归零
def test_consumes_lm_usage_event_serialization() -> None:
    ev = LlmUsageEvent(
        run_id="r1",
        input_tokens=42,
        output_tokens=7,
        cache_read_input_tokens=3,
        cache_creation_input_tokens=1,
        context_pct=0.5,
        model="test-model",
        ts="t1",
    )
    usage = summarize_token_usage([ev.model_dump()])
    assert usage.input_tokens == 42
    assert usage.output_tokens == 7
    assert usage.cache_read_input_tokens == 3
    assert usage.cache_creation_input_tokens == 1
