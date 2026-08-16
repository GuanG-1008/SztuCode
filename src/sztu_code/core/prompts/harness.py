from __future__ import annotations

from dataclasses import dataclass

from sztu_code.core.prompts.catalog import DEFAULT_PROMPT_CATALOG, PromptCatalog


@dataclass(frozen=True)
class PromptRuntimeContext:
    permission_mode: str = "normal"
    memory_enabled: bool = False


class PromptHarness:
    # 初始化运行时提示词组合器并允许测试注入独立目录
    def __init__(self, catalog: PromptCatalog | None = None) -> None:
        self._catalog = catalog or DEFAULT_PROMPT_CATALOG

    # 根据当前运行能力选择真正需要注入的动态原子提示词
    def runtime_entries(self, context: PromptRuntimeContext) -> tuple[str, ...]:
        entries: list[str] = []
        if context.permission_mode == "auto":
            entries.append(self._catalog.get("safety-prompts", "auto-mode").content)
        if context.memory_enabled:
            entries.append(self._catalog.get("memory-system-prompts", "auto-memory").content)
        return tuple(entries)

    # 将运行时原子提示词追加到既有基座且保持基座字节稳定
    def compose(self, base_prompt: str, context: PromptRuntimeContext) -> str:
        return "\n\n".join((base_prompt, *self.runtime_entries(context)))


DEFAULT_PROMPT_HARNESS = PromptHarness()
