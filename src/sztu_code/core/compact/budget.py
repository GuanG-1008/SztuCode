from __future__ import annotations

from typing import Any

TOOL_RESULT_LIMIT = 8_000
TOOL_RESULT_KEEP = 4_000

# 上下文卸载占位符标记 — 已被卸载的内容不需要再截断
_OFFLOAD_MARKER = "[上下文卸载:"


# 对消息列表中超长的 tool_result 内容做内存截断，返回处理后的新列表
# 已被上下文卸载（含 [上下文卸载: 标记）的内容跳过截断
def truncate_tool_results(
    messages: list[dict[str, Any]],
    limit: int = TOOL_RESULT_LIMIT,
    keep: int = TOOL_RESULT_KEEP,
) -> list[dict[str, Any]]:
    result = []
    for msg in messages:
        if msg.get("role") != "user":
            result.append(msg)
            continue
        content = msg.get("content")
        if not isinstance(content, list):
            result.append(msg)
            continue
        new_blocks = []
        for block in content:
            if block.get("type") == "tool_result" and isinstance(block.get("content"), str):
                text = block["content"]
                # 已被上下文卸载的内容 — 占位符很短，不需要截断
                if _OFFLOAD_MARKER in text:
                    new_blocks.append(block)
                    continue
                if len(text) > limit:
                    omitted = len(text) - keep
                    block = dict(block)
                    block["content"] = (
                        text[:keep]
                        + f"\n[... {omitted} chars omitted. Full output in run events.]"
                    )
            new_blocks.append(block)
        result.append({**msg, "content": new_blocks})
    return result
