from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

_CHARS_PER_TOKEN_FALLBACK = 4  # 回退方案：每 token 约 4 个英文字符


# 精确 Token 计数器，tiktoken 不可用时回退到字符估算
class TokenCounter:
    # 初始化，尝试加载 cl100k_base 编码器（GPT-4 / Claude 兼容）
    def __init__(self) -> None:
        self._encoder = None
        try:
            import tiktoken  # type: ignore[import-not-found]
            self._encoder = tiktoken.get_encoding("cl100k_base")
        except (ImportError, ValueError):
            logger.debug("tiktoken 不可用，回退到字符估算 (len//4)")

    # 计算文本的 token 数量
    def count(self, text: str) -> int:
        if self._encoder is not None:
            try:
                return len(self._encoder.encode(text))
            except Exception:
                pass  # 编码失败时回退
        return max(1, len(text) // _CHARS_PER_TOKEN_FALLBACK)

    # 计算消息列表的总 token 数
    def count_messages(self, messages: list[dict[str, Any]]) -> int:
        total = 0
        for msg in messages:
            content = msg.get("content", "")
            if isinstance(content, str):
                total += self.count(content)
            elif isinstance(content, list):
                for block in content:
                    if isinstance(block, dict):
                        text = block.get("text", "") or block.get("content", "")
                        if isinstance(text, str):
                            total += self.count(text)
        return max(1, total)

    # 精确 token 计数是否可用
    @property
    def precise_available(self) -> bool:
        return self._encoder is not None
