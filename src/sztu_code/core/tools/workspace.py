from __future__ import annotations

from pathlib import Path, PureWindowsPath


# 将工具相对路径解析到指定工作区并拒绝越界访问
def resolve_workspace_path(workspace_root: Path | None, relative_path: str) -> Path:
    root = (workspace_root or Path.cwd()).resolve()
    if Path(relative_path).is_absolute() or PureWindowsPath(relative_path).anchor:
        raise PermissionError(f"path escapes workspace: {relative_path}")
    candidate = (root / relative_path).resolve()
    try:
        candidate.relative_to(root)
    except ValueError:
        raise PermissionError(f"path escapes workspace: {relative_path}") from None
    return candidate
