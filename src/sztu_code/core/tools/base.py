# 工具基类 —— 所有内置工具和插件工具均继承此类
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import StrEnum
from typing import ClassVar

from pydantic import BaseModel

_PERMISSION_GRANT_KEY = "__sztu_permission_grant__"
_PERMISSION_GRANT_TOKEN = object()


class ToolPermission(StrEnum):
    """工具权限级别，与 PermissionMode 对应"""
    READ_ONLY = "read_only"            # 只读：read_file, list_dir 等
    WORKSPACE_WRITE = "workspace_write"  # 工作区内写入：write_file, note_save
    DANGER_FULL_ACCESS = "danger_full_access"  # 高风险：bash, 外部路径操作


@dataclass
class ToolResult:
    content: str
    is_error: bool = False
    # "runtime_error" | "timeout" | "schema_error" | "permission_denied"
    error_type: str | None = None
    # 供内部组合工具读取的结构化执行元数据，不直接展示给模型
    metadata: dict[str, object] = field(default_factory=dict)


class BaseTool(ABC):
    name: str
    description: str
    input_schema: dict[str, object]
    params_model: ClassVar[type[BaseModel] | None] = None
    # 每个工具声明自身所需的最低权限级别
    required_permission: ToolPermission = ToolPermission.WORKSPACE_WRITE
    # 交互工具不参与并发只读批次，避免同一步中多个等待态争用输入区域
    is_interactive: bool = False
    # 用户交互等待由 run 取消控制，不受普通工具执行超时限制
    allows_indefinite_wait: bool = False
    # 工具名称别名列表（如 "read" → "read_file"）
    aliases: ClassVar[list[str]] = []

    # 执行工具调用，返回结果或错误
    @abstractmethod
    async def invoke(self, params: dict[str, object]) -> ToolResult: ...

    # 动态权限分级：根据输入参数返回实际所需权限级别（子类可覆盖）
    def classify_permission(self, params: dict[str, object]) -> ToolPermission:
        """根据输入参数动态判断权限级别。默认返回 required_permission。"""
        return self.required_permission
